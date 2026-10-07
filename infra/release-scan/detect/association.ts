import { parseArsc } from './arsc.ts';
import type { ArscTable } from './arsc.ts';
import { axmlText } from './axml.ts';
import { textViews } from './encoding.ts';
import { moduleJsonText, parseResourcesIndex } from './harmony.ts';
import type { HarmonyTable } from './harmony.ts';
import { UNRESOLVED } from './lines.ts';
import type { FileReader } from './lines.ts';
import { parseResourcesPb, protoXmlText } from './proto.ts';
import type { ProtoTable } from './proto.ts';
import { NESTED } from './read.ts';
import type { ArtifactEntry } from './types.ts';

/** 完整制品的字段视图；path 保留引用方的包内路径，text 使用 JSON 键值行。 */
export interface ArtifactTextView {
  path: string;
  text: string;
  /**
   * 资源表（resources.arsc）的键值视图：键是任意资源名，keyed-credential 只认整词或已知连写，
   * 不按 key / token 子串命中（monkey、tokenizer 不是凭据字段）。
   */
  resourceNames?: boolean;
}

export interface ArtifactTextViews {
  views: ArtifactTextView[];
  /** 损坏的结构、无法解析的签名字段引用记为读取错误；其他条目继续扫描。 */
  errors: string[];
}

type Kind =
  | 'arsc'
  | 'axml-manifest'
  | 'proto-manifest'
  | 'proto-table'
  | 'module-json'
  | 'resources-index'
  | 'plain';

interface Located {
  /** 所在包（嵌套制品）的路径前缀，根制品为空串。 */
  root: string;
  /** 包内相对路径。 */
  rel: string;
}

function locate(path: string): Located {
  const parts = path.split('/');
  for (let i = parts.length - 2; i >= 0; i--) {
    const dot = parts[i]!.lastIndexOf('.');
    if (dot > 0 && NESTED.has(parts[i]!.slice(dot).toLowerCase())) {
      return { root: parts.slice(0, i + 1).join('/'), rel: parts.slice(i + 1).join('/') };
    }
  }
  return { root: '', rel: path };
}

/** 不复制条目内容（大制品的内存预算由读取段控制）。 */
const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const join = (root: string, rel: string): string => (root ? `${root}/${rel}` : rel);

const isAxml = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && bytes[0] === 3 && bytes[1] === 0 && bytes[2] === 8 && bytes[3] === 0;

/**
 * 文本 XML（.aar 等里的源清单）不按 AXML / proto 解析：跳过前导 BOM、空白、注释与处理指令后，
 * 根元素是 <manifest>（或开头是 XML 声明）即为文本清单。
 */
const isTextXml = (bytes: Uint8Array): boolean => {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    return true;
  const head = Buffer.from(bytes.subarray(0, 64 * 1024)).toString('latin1');
  return /^(?:\xef\xbb\xbf)?(?:\s|<!--(?:(?!-->)[^])*-->|<\?(?:(?!\?>)[^])*\?>|<!DOCTYPE\b[^>]*>)*<(?:\?xml|manifest)\b/.test(
    head,
  );
};

/** 文件资源内容按文本读取：去 BOM，合法 UTF-8 按 UTF-8，否则按 latin1。 */
function fileText(content: Uint8Array): string {
  let bytes = asBuffer(content);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * 关联视图逐行是 JSON 键值行，取值里的引号、反斜杠、换行会被再次转义，
 * 如字符串资源内容 {"shared_salt":"…"} 在视图里变成 {\"shared_salt\":…}，字段检测认不出。
 * 这里把这类取值按解码后的原样取出，以 NUL 分隔（与二进制里的独立串同一口径）另作一个视图检测。
 */
function rawStrings(text: string): string | undefined {
  const raw = new Set<string>();
  const escaped = (value: string): boolean => JSON.stringify(value) !== `"${value}"`;
  for (const line of text.split('\n')) {
    if (!line.includes('\\')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      try {
        parsed = JSON.parse(`{${line}}`);
      } catch {
        continue;
      }
    }
    const values =
      typeof parsed === 'string'
        ? [parsed]
        : parsed && typeof parsed === 'object'
          ? Object.entries(parsed).flat()
          : [];
    for (const value of values) if (typeof value === 'string' && escaped(value)) raw.add(value);
  }
  return raw.size > 0 ? `\0${[...raw].join('\0')}\0` : undefined;
}

function classify(entry: ArtifactEntry): Kind {
  const { rel } = locate(entry.path);
  if (/(?:^|\/)resources\.arsc$/i.test(entry.path)) return 'arsc';
  // 包根的二进制清单：不是文本 XML 就必须是可读的 AXML，类型头损坏不能降级成普通二进制放行。
  if (rel === 'AndroidManifest.xml' && !isTextXml(entry.content)) return 'axml-manifest';
  // .aab 模块：<模块>/manifest/AndroidManifest.xml 是 aapt2 proto XmlNode，<模块>/resources.pb 是 ResourceTable。
  if (/^[^/]+\/manifest\/AndroidManifest\.xml$/.test(rel)) {
    return isAxml(entry.content) || isTextXml(entry.content) ? 'plain' : 'proto-manifest';
  }
  if (/^(?:[^/]+\/)?resources\.pb$/.test(rel)) return 'proto-table';
  if (rel === 'module.json') return 'module-json';
  if (rel === 'resources.index') return 'resources-index';
  return 'plain';
}

type Loaded<T> = { ok: true; table: T } | { ok: false };

/**
 * QA-09d：在同一制品内关联清单与资源表，并恢复可供扫描和 QA-09c 使用的字段视图。
 * 嵌套包分别解析；不跨兄弟包借用资源。scanArtifact 须使用同一关联语义。
 * 不认识的普通条目继续使用既有文本视图，不丢失其他密钥检测。
 */
export function artifactTextViews(entries: readonly ArtifactEntry[]): ArtifactTextViews {
  const views: ArtifactTextView[] = [];
  const errors: string[] = [];
  const byPath = new Map<string, ArtifactEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  const cache = new Map<string, Loaded<unknown>>();
  // 资源表按路径只解析一次；读不了的表对引用方等同于缺表（签名字段引用因此 fail-closed）。
  const load = <T>(path: string, parse: (bytes: Buffer) => T): Loaded<T> | undefined => {
    const entry = byPath.get(path);
    if (!entry) return;
    const known = cache.get(path) as Loaded<T> | undefined;
    if (known) return known;
    let loaded: Loaded<T>;
    try {
      loaded = { ok: true, table: parse(asBuffer(entry.content)) };
    } catch {
      loaded = { ok: false };
    }
    cache.set(path, loaded);
    return loaded;
  };
  const table = <T>(path: string, parse: (bytes: Buffer) => T): T => {
    const loaded = load(path, parse);
    if (!loaded?.ok) throw new Error('Resource table unreadable');
    return loaded.table;
  };
  const optionalTable = <T>(path: string, parse: (bytes: Buffer) => T): T | undefined => {
    const loaded = load(path, parse);
    return loaded?.ok ? loaded.table : undefined;
  };

  // 同一包内的文件资源；路径含 .. / 绝对路径或落进嵌套包的都算读不到。
  const reader =
    (root: string, candidates: (path: string) => string[]): FileReader =>
    (path) => {
      if (!path || path.startsWith('/') || path.split('/').some((s) => s === '..' || s === '.'))
        return;
      for (const rel of candidates(path)) {
        if (!rel) continue;
        const full = join(root, rel);
        const entry = byPath.get(full);
        if (entry && locate(full).root === root) return fileText(entry.content);
      }
      return;
    };
  // APK：res/… 相对包根；AAB：相对模块目录；HAP：值带模块名前缀（entry/resources/…），包内路径去掉首段。
  const apkFiles = (root: string): FileReader => reader(root, (path) => [path]);
  const aabFiles = (root: string, module: string): FileReader =>
    reader(root, (path) => (module ? [`${module}/${path}`, path] : [path]));
  const hapFiles = (root: string): FileReader =>
    reader(root, (path) => [path, path.slice(path.indexOf('/') + 1)]);
  const push = (path: string, text: string, resourceNames = false): void => {
    views.push(resourceNames ? { path, text, resourceNames } : { path, text });
    const raw = rawStrings(text);
    if (raw !== undefined) views.push({ path, text: raw });
  };

  for (const entry of entries) {
    const { root, rel } = locate(entry.path);
    try {
      const bytes = asBuffer(entry.content);
      switch (classify(entry)) {
        case 'arsc': {
          const files = apkFiles(root);
          push(entry.path, table<ArscTable>(entry.path, (b) => parseArsc(b, files)).text, true);
          break;
        }
        case 'axml-manifest': {
          const files = apkFiles(root);
          const arsc = optionalTable<ArscTable>(join(root, 'resources.arsc'), (b) =>
            parseArsc(b, files),
          );
          const text = axmlText(
            bytes,
            (id, kind) => (arsc && kind === 'ref' ? arsc.resolve(id) : UNRESOLVED),
            files,
          );
          push(entry.path, text);
          break;
        }
        case 'proto-manifest': {
          const module = rel.slice(0, rel.indexOf('/'));
          const files = aabFiles(root, module);
          const pb = optionalTable<ProtoTable>(join(root, `${module}/resources.pb`), (b) =>
            parseResourcesPb(b, files),
          );
          const text = protoXmlText(bytes, (ref) => (pb ? pb.resolve(ref) : UNRESOLVED), files);
          push(entry.path, text);
          break;
        }
        case 'proto-table': {
          const module = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
          const files = aabFiles(root, module);
          push(entry.path, table<ProtoTable>(entry.path, (b) => parseResourcesPb(b, files)).text);
          break;
        }
        case 'module-json': {
          const files = hapFiles(root);
          const index = optionalTable<HarmonyTable>(join(root, 'resources.index'), (b) =>
            parseResourcesIndex(b, files),
          );
          const text = moduleJsonText(
            bytes,
            (ref) => (index ? index.resolve(ref) : UNRESOLVED),
            files,
          );
          push(entry.path, text);
          break;
        }
        case 'resources-index': {
          const files = hapFiles(root);
          push(
            entry.path,
            table<HarmonyTable>(entry.path, (b) => parseResourcesIndex(b, files)).text,
          );
          break;
        }
        default:
          for (const text of textViews(entry.content, entry.path, true)) {
            views.push({ path: entry.path, text });
          }
      }
    } catch {
      errors.push(`Artifact content unreadable: ${entry.path}`);
    }
  }
  return { views, errors };
}

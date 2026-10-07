import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll } from 'vitest';
import type { DetectRuleId, ScanHit } from '../../../../infra/release-scan/detect/index.ts';

// 假值一律在运行时拼接，源码里不留下像密钥的字面量（仓库 .gitleaks.toml 不会命中），一眼可辨是假的。

/** 36 个互不相同的字符，前 k 个总同时含字母与数字。 */
export const ALPHA = 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ';
export const HEX16 = '0123456789abcdef';

/**
 * 用 ALPHA 的前 k 个字符循环拼出长度 len 的串。len 为 k 的整数倍时香农熵恰为 log2(k)：
 * k=16 → 4.0，k=12 → 约 3.585，k=11 → 约 3.459，k=8 → 3.0，k=7 → 约 2.807。
 */
export function spread(k: number, len: number): string {
  return Array.from({ length: len }, (_, i) => ALPHA[i % k]).join('');
}

const DASH = '-'.repeat(5);
/** PEM 边界行，如 pem('BEGIN', 'RSA PRIVATE KEY')。 */
export function pem(edge: 'BEGIN' | 'END', label: string): string {
  return `${DASH}${edge} ${label}${DASH}`;
}

export const FAKE = {
  /** 32 位小写十六进制，熵只有 2.0（低熵的服务端密钥格式）。 */
  hex32Low: 'ab12'.repeat(8),
  /** 40 位小写十六进制，低熵。 */
  hex40Low: 'cd345'.repeat(8),
  /** 32 位小写十六进制，熵 4.0。 */
  hex32High: HEX16.repeat(2),
  /** 阿里云 AccessKey ID 形状（前缀 + 20 位）。 */
  akId: `${['LT', 'AI'].join('')}${spread(20, 20)}`,
  /** 阿里云 AccessKey ID 旧形状（前缀 + 12 位）。 */
  akIdShort: `${['LT', 'AI'].join('')}${spread(12, 12)}`,
  /** 明显的示例口令。 */
  password: `EXAMPLE${spread(12, 12)}`,
  /** 64 位高熵 base64 行（PEM 正文）。 */
  pemBody: spread(36, 64),
  get dsn(): string {
    return `https://${this.hex32High}@o1.ingest.example.test/42`;
  },
};

/** 一个完整的 PEM 块（header、两行正文、footer），用 \n 分行。 */
export function pemBlock(label: string): string {
  return [pem('BEGIN', label), FAKE.pemBody, FAKE.pemBody, pem('END', label)].join('\n');
}

/** 口径：各规则是否不可豁免（02 §12.6 不可豁免；BR-ID-09 签名材料与共享盐）。 */
export const NEVER: Record<DetectRuleId, boolean> = {
  'private-key': true,
  'request-sign-material': true,
  'server-secret': true,
  'aliyun-access-key': true,
  'credential-url': true,
  'keyed-credential': false,
  'high-entropy': false,
};

/** 期望的命中（每次新建对象，不与被测返回值共享引用）。 */
export function want(rule: DetectRuleId, file: string, line: number, match: string): ScanHit {
  return { rule, file, line, match, never_accepted: NEVER[rule] };
}

/** 按 file、line、rule、match 排序的拷贝（不改入参）。 */
export function sorted(hits: readonly ScanHit[]): ScanHit[] {
  const key = (h: ScanHit) => [h.file, String(h.line).padStart(8, '0'), h.rule, h.match].join('\0');
  return [...hits].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---- zip 制品（测试运行时现场生成，不入库） ----

export interface ZipFile {
  name: string;
  data: string | Uint8Array;
  /** 0 = stored，8 = deflate；其他值按原样写进头部（用来造不支持的压缩方式）。默认 8。 */
  method?: number;
  /** 用数据描述符：本地头的 crc 与长度写 0，真实值在数据之后与中央目录。 */
  descriptor?: boolean;
  /** 置加密标志位。 */
  encrypted?: boolean;
}

export function buildZip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const name = Buffer.from(f.name, 'utf8');
    const flags = (f.descriptor ? 0x08 : 0) | (f.encrypted ? 0x01 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(f.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(f.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(f.descriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const parts = [local, name, body];
    if (f.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(body.length, 8);
      d.writeUInt32LE(raw.length, 12);
      parts.push(d);
    }
    const chunk = Buffer.concat(parts);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(chunk);
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- 临时目录：仓库根 .tmp/QA-09b/（已被 git 与仓库 gitleaks 忽略），每个测试文件结束时删除 ----

const TMP_ROOT = fileURLToPath(new URL('../../../../.tmp/QA-09b/', import.meta.url));

/** 在测试文件里调用一次；返回的函数每次新建一个独立的临时目录。 */
export function tempDirs(): () => string {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'detect-'));
    made.push(dir);
    return dir;
  };
}

/** 在 dir 下写一个 zip 制品，返回路径。 */
export function writeZip(dir: string, name: string, files: readonly ZipFile[]): string {
  const path = join(dir, name);
  writeFileSync(path, buildZip(files));
  return path;
}

/** 在 root 下按相对路径写一组文件（构建产物目录），返回 root。 */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): string {
  for (const [rel, data] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return root;
}

const MANIFEST_URL = new URL('../../../../specs/client-public-ids.yaml', import.meta.url);
const EMPTY_LISTS = 'false_positives: []\nexceptions: []\n';

/** 仓库里的真实公开标识清单原文。 */
export function realManifest(): string {
  return readFileSync(MANIFEST_URL, 'utf8');
}

/** 真实清单，把空的 false_positives / exceptions 换成给定片段；清单已非空时抛错（夹具前提不成立）。 */
export function manifestWith(lists: string): string {
  const text = realManifest();
  if (!text.includes(EMPTY_LISTS)) throw new Error('夹具前提：真实清单的两张列表应为空');
  return text.replace(EMPTY_LISTS, lists);
}

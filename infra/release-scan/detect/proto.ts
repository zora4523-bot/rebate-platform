// .aab 模块里 aapt2 的 protobuf 资源表（resources.pb）与 proto 清单（manifest/AndroidManifest.xml）。
// 字段号依据 AOSP tools/aapt2/Resources.proto 与 ResourcesInternal.proto；只解析数据，不加载任何运行时。
// 口径：损坏、越界、未知 wire type、子消息内部截断一律抛错（fail-closed）；未知字段按 wire 层校验后跳过，
// 其中的长度限定内容只取可打印串作孤立字符串检测。属性名与取值以编译值（compiled_item / Item）为准，
// 原始文本（XmlAttribute.value）只作补充。

import { FILE_TYPES, STRUCTURE_TYPES } from './arsc.ts';
import { associationNames, emitFinal, LineSink, UNRESOLVED, printableRuns } from './lines.ts';
import type { FileReader, Final, Resolution } from './lines.ts';
import { fieldRule } from './rules.ts';

interface Field {
  num: number;
  wire: number;
  int: bigint;
  bytes: Buffer;
}

export interface ProtoRef {
  id: number;
  name: string;
  /** Reference.type = ATTRIBUTE（?attr/…）：制品内无法静态解析。 */
  attr: boolean;
}

type PValue = { kind: 'text'; text: string; file: boolean } | { kind: 'ref'; ref: ProtoRef };

interface Context {
  work: number;
  /** 孤立字符串：未知字段与不参与关联的已知文本字段（注释、命名空间、样式标签、引用名等）。 */
  loose: string[];
}

const MAX_WORK = 5_000_000;
const MAX_DEPTH = 64;
const MAX_REFERENCE_DEPTH = 8;
const EMPTY: Buffer = Buffer.alloc(0);

const invalid = (): never => {
  throw new Error('Invalid or unsupported protobuf resource');
};

function decode(buf: Buffer, ctx: Context, depth: number): Field[] {
  if (depth > MAX_DEPTH) invalid();
  const out: Field[] = [];
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= buf.length) return invalid();
      const byte = buf[at++]!;
      result |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if (!(byte & 0x80)) {
        if (result >= 1n << 64n) invalid();
        return result;
      }
    }
    return invalid();
  };
  while (at < buf.length) {
    if (++ctx.work > MAX_WORK) invalid();
    const tag = varint();
    const num = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (tag > 0xffffffffn || num < 1) invalid();
    let int = 0n;
    let bytes: Buffer = EMPTY;
    if (wire === 0) int = varint();
    else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (at + width > buf.length) invalid();
      bytes = buf.subarray(at, at + width);
      int = wire === 1 ? buf.readBigUInt64LE(at) : BigInt(buf.readUInt32LE(at));
      at += width;
    } else if (wire === 2) {
      const length = varint();
      if (length > BigInt(buf.length - at)) invalid();
      bytes = buf.subarray(at, at + Number(length));
      at += bytes.length;
    } else invalid(); // 3 / 4（group）与 6 / 7 都不是 aapt2 会产出的编码。
    out.push({ num, wire, int, bytes });
  }
  return out;
}

function want(f: Field, wire: number): Field {
  if (f.wire !== wire) invalid();
  return f;
}

const text = (f: Field): string => want(f, 2).bytes.toString('utf8');
const u32 = (f: Field): number => Number(BigInt.asUintN(32, want(f, 0).int));

function unknown(f: Field, ctx: Context): void {
  if (f.wire === 2) for (const run of printableRuns(f.bytes)) ctx.loose.push(run);
}

/** 不参与关联的已知文本字段（Value.comment 等）：解码后保留为孤立字符串参与检测，不丢弃。 */
function keep(f: Field, ctx: Context): void {
  const value = text(f);
  if (value !== '') ctx.loose.push(value);
}

/**
 * 内容用不到的已知消息：仍逐层做 wire 校验，内部截断同样拒绝。
 * 其中不再下钻的长度限定字段（Visibility / OverlayableItem 的 comment、XmlNamespace 的 prefix / uri、
 * StyledString.Span 的 tag 等）取可打印串作孤立字符串，保留原始字节扫描能看到的文本。
 */
function opaque(f: Field, ctx: Context, depth: number, nested: readonly number[] = []): void {
  for (const g of decode(want(f, 2).bytes, ctx, depth + 1)) {
    if (nested.includes(g.num)) opaque(g, ctx, depth + 1);
    else unknown(g, ctx);
  }
}

/** 只校验、不参与关联的引用：引用名保留为孤立字符串。 */
function looseReference(f: Field, ctx: Context, depth: number): void {
  const ref = reference(want(f, 2).bytes, ctx, depth);
  if (ref && ref.name !== '') ctx.loose.push(ref.name);
}

/** Source { path_idx=1, position=2 (SourcePosition) } */
const source = (f: Field, ctx: Context, depth: number): void => opaque(f, ctx, depth, [2]);

function reference(buf: Buffer, ctx: Context, depth: number): ProtoRef | undefined {
  let id = 0;
  let name = '';
  let attr = false;
  for (const f of decode(buf, ctx, depth)) {
    if (f.num === 1) attr = want(f, 0).int === 1n;
    else if (f.num === 2) id = u32(f);
    else if (f.num === 3) name = text(f);
    else if (f.num === 5)
      opaque(f, ctx, depth); // is_dynamic: Boolean
    else if (f.num === 4 || f.num === 6 || f.num === 7) want(f, 0);
    else unknown(f, ctx);
  }
  // id 0 且无名字是 @null：没有取值。
  return id === 0 && name === '' ? undefined : { id, name, attr };
}

function primitive(buf: Buffer, ctx: Context, depth: number): PValue[] {
  const out: PValue[] = [];
  const push = (value: string): void => {
    out.push({ kind: 'text', text: value, file: false });
  };
  for (const f of decode(buf, ctx, depth)) {
    switch (f.num) {
      case 1:
      case 2:
        opaque(f, ctx, depth); // null_value / empty_value
        break;
      case 3:
      case 4:
      case 5:
        push(String(want(f, 5).bytes.readFloatLE(0)));
        break;
      case 6:
        push(String(BigInt.asIntN(32, want(f, 0).int)));
        break;
      case 8:
        push(want(f, 0).int === 0n ? 'false' : 'true');
        break;
      case 9:
      case 10:
      case 11:
      case 12:
        push(`#${u32(f).toString(16).padStart(8, '0')}`);
        break;
      case 7:
      case 13:
      case 14:
        push(String(u32(f)));
        break;
      default:
        unknown(f, ctx);
    }
  }
  return out;
}

function item(buf: Buffer, ctx: Context, depth: number): PValue[] {
  const out: PValue[] = [];
  for (const f of decode(buf, ctx, depth)) {
    switch (f.num) {
      case 1: {
        const ref = reference(want(f, 2).bytes, ctx, depth + 1);
        if (ref) out.push({ kind: 'ref', ref });
        break;
      }
      case 2:
      case 3:
      case 4: {
        // String / RawString / StyledString：value=1；StyledString.span=2 只校验。
        for (const g of decode(want(f, 2).bytes, ctx, depth + 1)) {
          if (g.num === 1) out.push({ kind: 'text', text: text(g), file: false });
          else if (f.num === 4 && g.num === 2) opaque(g, ctx, depth + 1);
          else unknown(g, ctx);
        }
        break;
      }
      case 5: {
        // FileReference { path=1, type=2 }
        for (const g of decode(want(f, 2).bytes, ctx, depth + 1)) {
          if (g.num === 1) out.push({ kind: 'text', text: text(g), file: true });
          else if (g.num === 2) want(g, 0);
          else unknown(g, ctx);
        }
        break;
      }
      case 6:
        opaque(f, ctx, depth); // Id
        break;
      case 7:
        out.push(...primitive(want(f, 2).bytes, ctx, depth + 1));
        break;
      default:
        unknown(f, ctx);
    }
  }
  return out;
}

interface ConfigValue {
  values: PValue[];
  /** 样式条目项：主题属性到资源的映射，不配字段名。 */
  structure: boolean;
}

/** 复合值里带 item 的子消息（Array.Element / Plural.Entry / Style.Entry）。 */
function itemsOf(
  buf: Buffer,
  ctx: Context,
  depth: number,
  itemField: number,
  refFields: readonly number[] = [],
): PValue[] {
  const out: PValue[] = [];
  for (const f of decode(buf, ctx, depth)) {
    if (f.num === itemField) out.push(...item(want(f, 2).bytes, ctx, depth + 1));
    else if (refFields.includes(f.num)) looseReference(f, ctx, depth + 1);
    else if (f.num === 1) source(f, ctx, depth);
    else if (f.num === 2)
      keep(f, ctx); // comment
    else unknown(f, ctx);
  }
  return out;
}

function compound(buf: Buffer, ctx: Context, depth: number): ConfigValue {
  const result: ConfigValue = { values: [], structure: false };
  for (const f of decode(buf, ctx, depth)) {
    const body = (): Field[] => decode(want(f, 2).bytes, ctx, depth + 1);
    switch (f.num) {
      case 1: // Attribute { symbol=4 { source=1, comment=2, name=3 Reference } }
        for (const g of body()) {
          if (g.num === 4) itemsOf(want(g, 2).bytes, ctx, depth + 2, 0, [3]);
          else unknown(g, ctx);
        }
        break;
      case 2: // Style { parent=1 Reference, parent_source=2, entry=3 { key=3 Reference, item=4 } }
        result.structure = true;
        for (const g of body()) {
          if (g.num === 1) looseReference(g, ctx, depth + 2);
          else if (g.num === 2) source(g, ctx, depth + 1);
          else if (g.num === 3)
            result.values.push(...itemsOf(want(g, 2).bytes, ctx, depth + 2, 4, [3]));
          else unknown(g, ctx);
        }
        break;
      case 3: // Styleable { entry=1 { attr=3 Reference } }
        for (const g of body()) {
          if (g.num === 1) itemsOf(want(g, 2).bytes, ctx, depth + 2, 0, [3]);
          else unknown(g, ctx);
        }
        break;
      case 4: // Array { element=1 { item=3 } }
        for (const g of body()) {
          if (g.num === 1) result.values.push(...itemsOf(want(g, 2).bytes, ctx, depth + 2, 3));
          else unknown(g, ctx);
        }
        break;
      case 5: // Plural { entry=1 { arity=3, item=4 } }
        for (const g of body()) {
          if (g.num !== 1) {
            unknown(g, ctx);
            continue;
          }
          for (const h of decode(want(g, 2).bytes, ctx, depth + 2)) {
            if (h.num === 4) result.values.push(...item(want(h, 2).bytes, ctx, depth + 3));
            else if (h.num === 3) want(h, 0);
            else if (h.num === 1) source(h, ctx, depth + 2);
            else if (h.num === 2)
              keep(h, ctx); // comment
            else unknown(h, ctx);
          }
        }
        break;
      case 6: // MacroBody { raw_string=1 }
        for (const g of body()) {
          if (g.num === 1) result.values.push({ kind: 'text', text: text(g), file: false });
          else unknown(g, ctx);
        }
        break;
      default:
        unknown(f, ctx);
    }
  }
  return result;
}

/** Value { source=1, comment=2, weak=3, item=4, compound_value=5 } */
function value(buf: Buffer, ctx: Context, depth: number): ConfigValue {
  const result: ConfigValue = { values: [], structure: false };
  for (const f of decode(buf, ctx, depth)) {
    if (f.num === 1) source(f, ctx, depth);
    else if (f.num === 2)
      keep(f, ctx); // comment：源码注释也可能留有签名材料
    else if (f.num === 3) want(f, 0);
    else if (f.num === 4) result.values.push(...item(want(f, 2).bytes, ctx, depth + 1));
    else if (f.num === 5) {
      const c = compound(want(f, 2).bytes, ctx, depth + 1);
      result.values.push(...c.values);
      result.structure ||= c.structure;
    } else unknown(f, ctx);
  }
  return result;
}

/** 消息 { id=1 }（PackageId / TypeId / EntryId）。 */
function idOf(f: Field, ctx: Context, depth: number): number {
  let id = 0;
  for (const g of decode(want(f, 2).bytes, ctx, depth + 1)) {
    if (g.num === 1) id = u32(g);
    else unknown(g, ctx);
  }
  return id;
}

interface Entry {
  pkg: string;
  type: string;
  name: string;
  id?: number;
  configs: ConfigValue[];
}

export interface ProtoTable {
  text: string;
  resolve(ref: ProtoRef): Resolution;
}

interface Resolved extends Resolution {
  partial: boolean;
}

/** ResourceTable { source_pool=1, package=2 { package_id=1, package_name=2, type=3 { type_id=1, name=2, entry=3 } } } */
export function parseResourcesPb(bytes: Buffer, readFile?: FileReader): ProtoTable {
  const ctx: Context = { work: 0, loose: [] };
  const entries: Entry[] = [];
  for (const f of decode(bytes, ctx, 0)) {
    if (f.num === 1) {
      // source_pool：StringPool { data=1 }，里面是来源文件路径，只作孤立字符串。
      for (const g of decode(want(f, 2).bytes, ctx, 1)) {
        // 超大路径池（十几万条）不能展开传参（会超出调用栈参数上限），逐条追加。
        if (g.num === 1) for (const run of printableRuns(want(g, 2).bytes)) ctx.loose.push(run);
        else unknown(g, ctx);
      }
      continue;
    }
    if (f.num !== 2) {
      unknown(f, ctx);
      continue;
    }
    let pkgId: number | undefined;
    let pkg = '';
    const types: Field[] = [];
    for (const g of decode(want(f, 2).bytes, ctx, 1)) {
      if (g.num === 1) pkgId = idOf(g, ctx, 1);
      else if (g.num === 2) {
        pkg = text(g);
        keep(g, ctx); // package_name：只作孤立字符串
      } else if (g.num === 3) types.push(want(g, 2));
      else unknown(g, ctx);
    }
    for (const t of types) {
      let typeId: number | undefined;
      let type = '';
      const items: Field[] = [];
      for (const g of decode(t.bytes, ctx, 2)) {
        if (g.num === 1) typeId = idOf(g, ctx, 2);
        else if (g.num === 2) type = text(g);
        else if (g.num === 3) items.push(want(g, 2));
        else unknown(g, ctx);
      }
      for (const e of items) {
        let entryId: number | undefined;
        let name = '';
        const configs: ConfigValue[] = [];
        for (const g of decode(e.bytes, ctx, 3)) {
          if (g.num === 1) entryId = idOf(g, ctx, 3);
          else if (g.num === 2) name = text(g);
          else if (g.num === 3 || g.num === 4 || g.num === 5 || g.num === 8)
            opaque(g, ctx, 3); // visibility / allow_new / overlayable_item / staged_id
          else if (g.num === 6) {
            // ConfigValue { config=1, value=2 }
            for (const h of decode(want(g, 2).bytes, ctx, 4)) {
              if (h.num === 1) opaque(h, ctx, 4);
              else if (h.num === 2) configs.push(value(want(h, 2).bytes, ctx, 5));
              else unknown(h, ctx);
            }
          } else unknown(g, ctx);
        }
        const id =
          pkgId !== undefined && typeId !== undefined && entryId !== undefined
            ? ((pkgId << 24) | (typeId << 16) | entryId) >>> 0
            : undefined;
        if (
          entryId !== undefined &&
          (entryId > 0xffff || (typeId ?? 0) > 0xff || (pkgId ?? 0) > 0xff)
        )
          invalid();
        // 没有取值的条目名不会作为键输出，保留为孤立字符串。
        if (configs.every((c) => c.values.length === 0) && name !== '') ctx.loose.push(name);
        entries.push({ pkg, type, name, ...(id === undefined ? {} : { id }), configs });
      }
    }
  }

  const byId = new Map<number, Entry[]>();
  const byName = new Map<string, Entry[]>();
  const index = <K>(map: Map<K, Entry[]>, key: K, entry: Entry): void => {
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  for (const entry of entries) {
    if (entry.id !== undefined) index(byId, entry.id, entry);
    index(byName, `${entry.type}/${entry.name}`, entry);
    if (entry.pkg) index(byName, `${entry.pkg}:${entry.type}/${entry.name}`, entry);
  }
  const memo = new Map<string, Resolved>();
  const visiting = new Set<string>();
  const fileValue = (entry: Entry, v: { text: string; file: boolean }): boolean =>
    v.file || (FILE_TYPES.has(entry.type) && v.text.startsWith('res/'));
  const resolve = (ref: ProtoRef): Resolved => {
    if (++ctx.work > MAX_WORK) invalid();
    const name = ref.name.replace(/^[@?*+]+/, '');
    const key = ref.id ? `#${ref.id}` : `@${name}`;
    const known = memo.get(key);
    if (known) return known;
    const targets = ref.attr
      ? undefined
      : ((ref.id ? byId.get(ref.id) : undefined) ?? (name ? byName.get(name) : undefined));
    if (!targets || visiting.has(key) || visiting.size >= MAX_REFERENCE_DEPTH) {
      return { finals: [], ok: false, partial: !!targets };
    }
    visiting.add(key);
    const finals: Final[] = [];
    let ok = true;
    let partial = false;
    for (const target of targets) {
      for (const config of target.configs) {
        for (const v of config.values) {
          if (v.kind === 'text') {
            finals.push({ text: v.text, file: fileValue(target, v) });
            continue;
          }
          const next = resolve(v.ref);
          finals.push(...next.finals);
          ok &&= next.ok;
          partial ||= next.partial;
          if (finals.length > 100_000) invalid();
        }
      }
    }
    visiting.delete(key);
    const result = { finals, ok, partial };
    if (!partial) memo.set(key, result);
    return result;
  };

  const sink = new LineSink(invalid);
  const emit = (value: string, key?: string): void => sink.emit(value, key);
  for (const entry of entries) {
    const keylessType = FILE_TYPES.has(entry.type) || STRUCTURE_TYPES.has(entry.type);
    for (const config of entry.configs) {
      const keyless = keylessType || config.structure;
      for (const v of config.values) {
        if (v.kind === 'text') {
          if (keyless || fileValue(entry, v)) sink.emit(v.text);
          else sink.emit(v.text, entry.name);
          continue;
        }
        const resolved = resolve(v.ref);
        // 签名材料字段的引用解析不了时不能当成没有取值放行（fail-closed）。
        if (!resolved.ok && !keyless && fieldRule(entry.name) === 'request-sign-material')
          invalid();
        for (const final of resolved.finals) {
          if (keyless) sink.emit(final.text);
          else emitFinal(emit, final, entry.name, readFile, invalid);
        }
      }
    }
  }
  for (const run of ctx.loose) sink.emit(run);
  return {
    text: sink.text(),
    resolve: (ref: ProtoRef): Resolution => {
      const { finals, ok } = resolve(ref);
      return { finals: [...finals], ok };
    },
  };
}

interface XmlAttr {
  name: string;
  values: string[];
  files: string[];
  refs: ProtoRef[];
  rawRef?: string;
}

/**
 * proto 清单（XmlNode）。name + value / resource 属性按 meta-data 的 name 关联；引用经同模块 resources.pb 解析，
 * 签名材料字段解析不了时抛错。也输出 debuggable 等普通属性的字段视图，供残留检测读取。
 */
export function protoXmlText(
  bytes: Buffer,
  resolve?: (ref: ProtoRef) => Resolution,
  readFile?: FileReader,
): string {
  const ctx: Context = { work: 0, loose: [] };
  const sink = new LineSink(invalid);
  const emit = (value: string, key?: string): void => sink.emit(value, key);
  let elements = 0;
  const attribute = (buf: Buffer, depth: number): XmlAttr => {
    let name = '';
    let raw: string | undefined;
    const compiled: PValue[] = [];
    for (const f of decode(buf, ctx, depth)) {
      if (f.num === 1)
        keep(f, ctx); // namespace_uri
      else if (f.num === 2) name = text(f);
      else if (f.num === 3) raw = text(f);
      else if (f.num === 4)
        opaque(f, ctx, depth); // SourcePosition
      else if (f.num === 5) want(f, 0);
      else if (f.num === 6) compiled.push(...item(want(f, 2).bytes, ctx, depth + 1));
      else unknown(f, ctx);
    }
    const values: string[] = [];
    const files: string[] = [];
    const refs: ProtoRef[] = [];
    for (const v of compiled) {
      if (v.kind === 'ref') refs.push(v.ref);
      else if (v.file) files.push(v.text);
      else values.push(v.text);
    }
    const result: XmlAttr = { name, values, files, refs };
    if (raw !== undefined) {
      if (refs.length > 0) result.rawRef = raw;
      else if (!values.includes(raw) && !files.includes(raw)) values.push(raw);
    }
    return result;
  };
  const node = (buf: Buffer, depth: number): void => {
    for (const f of decode(buf, ctx, depth)) {
      if (f.num === 1) element(want(f, 2).bytes, depth + 1);
      else if (f.num === 2) sink.emit(text(f));
      else if (f.num === 3) opaque(f, ctx, depth);
      else unknown(f, ctx);
    }
  };
  const element = (buf: Buffer, depth: number): void => {
    if (++elements > 100_000) invalid();
    const attrs: XmlAttr[] = [];
    const children: Buffer[] = [];
    for (const f of decode(buf, ctx, depth)) {
      if (f.num === 1)
        opaque(f, ctx, depth, [3]); // XmlNamespace { prefix, uri, source }
      else if (f.num === 2 || f.num === 3)
        keep(f, ctx); // namespace_uri / name
      else if (f.num === 4) attrs.push(attribute(want(f, 2).bytes, depth + 1));
      else if (f.num === 5) children.push(want(f, 2).bytes);
      else unknown(f, ctx);
    }
    const names = associationNames(attrs, resolve, invalid);
    for (const attr of attrs) {
      const associated = (attr.name === 'value' || attr.name === 'resource') && names.length > 0;
      const keys = associated ? names : [attr.name];
      for (const v of attr.values) for (const key of keys) sink.emit(v, key);
      for (const file of attr.files) {
        for (const key of keys) emitFinal(emit, { text: file, file: true }, key, readFile, invalid);
      }
      if (attr.rawRef !== undefined) sink.emit(attr.rawRef);
      if (!resolve || attr.refs.length === 0) continue;
      if (!associated && keys.every((key) => fieldRule(key) === undefined)) continue;
      for (const ref of attr.refs) {
        let resolved: Resolution;
        try {
          resolved = resolve(ref);
        } catch {
          resolved = UNRESOLVED;
        }
        for (const key of keys) {
          if (!resolved.ok && fieldRule(key) === 'request-sign-material') invalid();
          for (const final of resolved.finals) emitFinal(emit, final, key, readFile, invalid);
        }
      }
    }
    for (const child of children) node(child, depth + 1);
  };
  node(bytes, 0);
  if (elements === 0) invalid();
  for (const run of ctx.loose) sink.emit(run);
  return sink.text();
}

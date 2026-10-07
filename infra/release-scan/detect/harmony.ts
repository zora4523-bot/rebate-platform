// .hap / .hsp：module.json 的 metadata 关联与 restool resources.index（旧格式）字符串资源。
// resources.index 布局依据 OpenHarmony developtools_global_resource_tool 的 resource_table.cpp
// （SaveHeader / SaveLimitKeyConfigs / SaveIdSets / SaveRecordItem）与 resource_data.h 的 ResType。
// 口径：结构损坏、越界一律抛错（fail-closed）；所有配置（语言、地区等）的候选值都参与检测与引用解析。

import { LineSink, UNRESOLVED } from './lines.ts';
import type { Final, Resolution } from './lines.ts';
import { fieldRule } from './rules.ts';

/** `$string:name`、`$string:16777216`（数字 ID）、`$ohos:string:x`（系统资源，制品内不可解析）。 */
export interface HarmonyRef {
  type: number;
  name: string;
  external: boolean;
}

// resource_data.h ResType；STRARRAY / INTARRAY / THEME / PLURAL / PATTERN 的取值是长度前缀的元素序列。
const TYPES: Readonly<Record<string, number>> = {
  integer: 8,
  string: 9,
  strarray: 10,
  intarray: 11,
  boolean: 12,
  color: 14,
  theme: 16,
  plural: 17,
  float: 18,
  media: 19,
  profile: 20,
  pattern: 22,
  symbol: 23,
};
const SEQUENCE_TYPES = new Set([10, 11, 16, 17, 22]);
/** MEDIA / PROF 的取值是包内文件路径，只作孤立字符串检测。 */
const FILE_TYPES = new Set([19, 20]);
const MAX_REFERENCE_DEPTH = 8;

export function harmonyRef(value: string): HarmonyRef | undefined {
  const m = /^\$(ohos:)?([a-z]+):(.+)$/.exec(value);
  if (!m) return;
  const type = TYPES[m[2]!];
  if (type === undefined) return;
  return { type, name: m[3]!, external: m[1] !== undefined };
}

interface IndexRecord {
  type: number;
  id: number;
  name: string;
  values: string[];
}

export interface HarmonyTable {
  text: string;
  resolve(ref: HarmonyRef): Resolution;
}

interface Resolved extends Resolution {
  partial: boolean;
}

const stripNul = (bytes: Buffer): Buffer =>
  bytes.length > 0 && bytes[bytes.length - 1] === 0 ? bytes.subarray(0, -1) : bytes;

export function parseResourcesIndex(bytes: Buffer): HarmonyTable {
  const invalid = (): never => {
    throw new Error('Invalid or unsupported HarmonyOS resources.index');
  };
  let work = 0;
  const tick = (): void => {
    if (++work > 2_000_000) invalid();
  };
  const u32 = (at: number, end = bytes.length): number => {
    if (at < 0 || at + 4 > end) return invalid();
    return bytes.readUInt32LE(at);
  };
  const u16 = (at: number, end: number): number => {
    if (at < 0 || at + 2 > end) return invalid();
    return bytes.readUInt16LE(at);
  };
  const tag = (at: number, expected: string): void => {
    if (at < 0 || at + 4 > bytes.length || bytes.toString('latin1', at, at + 4) !== expected)
      invalid();
  };
  if (bytes.length < 136) invalid();
  const version = bytes.subarray(0, 128);
  const nul = version.indexOf(0);
  const label = version.subarray(0, nul < 0 ? 128 : nul).toString('latin1');
  if (!/^[\x20-\x7e]+$/.test(label)) invalid();
  if (u32(128) !== bytes.length) invalid();
  const configCount = u32(132);
  if (configCount > 100_000) invalid();
  let pos = 136;
  const idss: number[] = [];
  for (let i = 0; i < configCount; i++) {
    tick();
    tag(pos, 'KEYS');
    idss.push(u32(pos + 4));
    const params = u32(pos + 8);
    if (params > 64) invalid();
    pos += 12 + params * 8;
    if (pos > bytes.length) invalid();
  }
  const headerEnd = pos;
  const records: IndexRecord[] = [];
  const byOffset = new Map<number, IndexRecord>();
  const sequence = (value: Buffer): string[] | undefined => {
    const out: string[] = [];
    let at = 0;
    while (at < value.length) {
      tick();
      if (at + 2 > value.length) return;
      const length = value.readUInt16LE(at);
      if (at + 2 + length > value.length) return;
      out.push(stripNul(value.subarray(at + 2, at + 2 + length)).toString('utf8'));
      at += 2 + length;
    }
    return out;
  };
  const record = (offset: number, id: number): IndexRecord => {
    const known = byOffset.get(offset);
    if (known) {
      if (known.id !== id) invalid();
      return known;
    }
    if (offset < headerEnd) invalid();
    const size = u32(offset);
    const end = offset + 4 + size;
    if (size < 12 || end > bytes.length) invalid();
    const type = u32(offset + 4, end);
    if (u32(offset + 8, end) !== id) invalid();
    let at = offset + 12;
    const valueLength = u16(at, end);
    at += 2;
    if (at + valueLength > end) invalid();
    const value = stripNul(bytes.subarray(at, at + valueLength));
    at += valueLength;
    const nameLength = u16(at, end);
    at += 2;
    if (at + nameLength !== end) invalid();
    const name = stripNul(bytes.subarray(at, end)).toString('utf8');
    if (name === '') invalid();
    let values: string[] | undefined;
    if (SEQUENCE_TYPES.has(type)) values = sequence(value);
    // 认不出元素序列的取值按控制字符切段，不丢内容。
    values ??= SEQUENCE_TYPES.has(type)
      ? value
          .toString('utf8')
          .split(/[\x00-\x1f]+/)
          .filter((part) => part !== '')
      : [value.toString('utf8')];
    const result = { type, id, name, values };
    byOffset.set(offset, result);
    records.push(result);
    return result;
  };
  const byId = new Map<number, IndexRecord[]>();
  const byName = new Map<string, IndexRecord[]>();
  const index = <K>(map: Map<K, IndexRecord[]>, key: K, r: IndexRecord): void => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(r)) list.push(r);
    } else map.set(key, [r]);
  };
  for (const at of idss) {
    tick();
    if (at < headerEnd) invalid();
    tag(at, 'IDSS');
    const count = u32(at + 4);
    if (count > 1_000_000 || at + 8 + count * 8 > bytes.length) invalid();
    for (let i = 0; i < count; i++) {
      tick();
      const id = u32(at + 8 + i * 8);
      const r = record(u32(at + 12 + i * 8), id);
      index(byId, r.id, r);
      index(byName, `${r.type}:${r.name}`, r);
    }
  }

  const memo = new Map<string, Resolved>();
  const visiting = new Set<string>();
  const resolve = (ref: HarmonyRef): Resolved => {
    tick();
    if (ref.external) return { finals: [], ok: false, partial: false };
    const numeric = /^\d+$/.test(ref.name);
    const key = numeric ? `#${ref.name}` : `${ref.type}:${ref.name}`;
    const known = memo.get(key);
    if (known) return known;
    const targets = numeric ? byId.get(Number(ref.name)) : byName.get(key);
    if (!targets || visiting.has(key) || visiting.size >= MAX_REFERENCE_DEPTH) {
      return { finals: [], ok: false, partial: !!targets };
    }
    visiting.add(key);
    const finals: Final[] = [];
    let ok = true;
    let partial = false;
    for (const target of targets) {
      for (const value of target.values) {
        const next = harmonyRef(value);
        if (!next) {
          finals.push({ text: value, file: FILE_TYPES.has(target.type) });
          continue;
        }
        const resolved = resolve(next);
        finals.push(...resolved.finals);
        ok &&= resolved.ok;
        partial ||= resolved.partial;
        if (finals.length > 100_000) invalid();
      }
    }
    visiting.delete(key);
    const result = { finals, ok, partial };
    if (!partial) memo.set(key, result);
    return result;
  };

  const sink = new LineSink(invalid);
  for (const r of records) {
    for (const value of r.values) {
      const ref = harmonyRef(value);
      if (!ref) {
        if (FILE_TYPES.has(r.type)) sink.emit(value);
        else sink.emit(value, r.name);
        continue;
      }
      sink.emit(value);
      const resolved = resolve(ref);
      // 签名材料资源的引用解析不了（缺 ID、成环）时不能当成没有取值放行。
      if (!resolved.ok && fieldRule(r.name) === 'request-sign-material') invalid();
      for (const final of resolved.finals) {
        if (final.file) sink.emit(final.text);
        else sink.emit(final.text, r.name);
      }
    }
  }
  return {
    text: sink.text(),
    resolve: (ref: HarmonyRef): Resolution => {
      const { finals, ok } = resolve(ref);
      return { finals: [...finals], ok };
    },
  };
}

/**
 * module.json：键值全部展开成 JSON 键值行；带 name 的对象（metadata 等）把 value / resource 关联到 name。
 * `$string:…` 等资源引用经同一包的 resources.index 解析；签名材料字段解析不了时抛错（fail-closed）。
 */
export function moduleJsonText(
  bytes: Buffer,
  resolve: (ref: HarmonyRef) => Resolution = () => UNRESOLVED,
): string {
  const invalid = (): never => {
    throw new Error('Invalid HarmonyOS module.json');
  };
  let body = bytes;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return invalid();
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) invalid();
  const sink = new LineSink(invalid);
  let visits = 0;
  const scalar = (value: string, key: string | undefined, keys: readonly string[]): void => {
    const ref = harmonyRef(value);
    if (!ref) {
      if (key === undefined) sink.emit(value);
      for (const k of keys) sink.emit(value, k);
      return;
    }
    sink.emit(value);
    let resolved: Resolution;
    try {
      resolved = resolve(ref);
    } catch {
      resolved = UNRESOLVED;
    }
    for (const k of keys) {
      if (!resolved.ok && fieldRule(k) === 'request-sign-material') invalid();
      for (const final of resolved.finals) {
        if (final.file) sink.emit(final.text);
        else sink.emit(final.text, k);
      }
    }
  };
  const walk = (value: unknown, key: string | undefined, depth: number): void => {
    if (++visits > 1_000_000 || depth > 128) invalid();
    if (Array.isArray(value)) {
      for (const child of value) walk(child, key, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const object = value as { [name: string]: unknown };
      const names = typeof object.name === 'string' && object.name !== '' ? [object.name] : [];
      for (const [k, child] of Object.entries(object)) {
        if (child !== null && typeof child === 'object') {
          walk(child, k, depth + 1);
          continue;
        }
        const keys = (k === 'value' || k === 'resource') && names.length > 0 ? [k, ...names] : [k];
        scalar(String(child), k, keys);
      }
      return;
    }
    const keys = key === undefined ? [] : [key];
    scalar(String(value), key, keys);
  };
  walk(root, undefined, 0);
  return sink.text();
}

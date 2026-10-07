import { fieldRule } from './rules.ts';

interface Chunk {
  at: number;
  type: number;
  header: number;
  end: number;
}

type Value = { kind: 'text' | 'number'; text: string } | { kind: 'ref'; id: number };

interface Entry {
  key: string;
  /** 资源类型名（string、drawable 等）。 */
  type: string;
  values: Value[];
}

interface Final {
  text: string;
  /** 文件类资源的路径取值（res/…）：只作孤立字符串检测，不配字段名。 */
  file: boolean;
}

interface Resolved {
  finals: Final[];
  ok: boolean;
  /** 遇到成环或深度截断；结果与入口有关，不缓存。 */
  partial: boolean;
}

const MAX_REFERENCE_DEPTH = 8;

/** 这些资源类型的字符串取值是包内文件路径，键名是文件名（如 avd_hide_password），不是字段。 */
const FILE_TYPES = new Set([
  'anim',
  'animator',
  'color',
  'drawable',
  'font',
  'interpolator',
  'layout',
  'menu',
  'mipmap',
  'navigation',
  'raw',
  'transition',
  'xml',
]);

/** 样式与属性定义：条目项是主题属性到资源的映射，不是「字段 = 取值」。 */
const STRUCTURE_TYPES = new Set(['attr', 'style']);

function fileValue(entry: Entry, value: Value): boolean {
  return value.kind === 'text' && FILE_TYPES.has(entry.type) && value.text.startsWith('res/');
}

/** ResTable 格式依据 Android ResourceTypes.h；只读内存，不加载 Android 资源运行时。 */
export function arscText(bytes: Buffer): string {
  const invalid = (): never => {
    throw new Error('Invalid or unsupported Android resource table');
  };
  const NONE = 0xffffffff;
  let work = 0;
  let decodedSize = 0;
  let outputSize = 0;
  const tick = (): void => {
    if (++work > 1_000_000) invalid();
  };
  const u16 = (at: number, end: number): number => {
    if (at < 0 || at + 2 > end || end > bytes.length) return invalid();
    return bytes.readUInt16LE(at);
  };
  const u32 = (at: number, end: number): number => {
    if (at < 0 || at + 4 > end || end > bytes.length) return invalid();
    return bytes.readUInt32LE(at);
  };
  const chunk = (at: number, limit: number): Chunk => {
    tick();
    const type = u16(at, limit);
    const header = u16(at + 2, limit);
    const size = u32(at + 4, limit);
    if (at % 4 || header < 8 || header % 4 || size < header || size % 4 || at + size > limit)
      invalid();
    return { at, type, header, end: at + size };
  };
  const children = (parent: Chunk): Chunk[] => {
    const result: Chunk[] = [];
    for (let at = parent.at + parent.header; at < parent.end;) {
      const child = chunk(at, parent.end);
      result.push(child);
      at = child.end;
    }
    return result;
  };
  const get = (pool: readonly string[], ref: number): string => pool[ref] ?? invalid();
  const used = new Set<string>();
  const emitted = new Set<string>();
  const lines: string[] = [];
  const emit = (value: string, key?: string): void => {
    const line =
      key === undefined ? JSON.stringify(value) : `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    // 多个配置或引用方给出同一行时只输出一次。
    if (emitted.has(line)) return;
    emitted.add(line);
    outputSize += line.length + 1;
    if (outputSize > 256 * 1024 * 1024 || lines.length >= 200_000) invalid();
    if (key !== undefined) used.add(key);
    used.add(value);
    lines.push(line);
  };
  const pool = (c: Chunk): string[] => {
    const { at, header, end } = c;
    if (c.type !== 1 || header < 28) invalid();
    const count = u32(at + 8, end);
    const styles = u32(at + 12, end);
    const flags = u32(at + 16, end);
    if ((flags & ~0x101) !== 0) invalid();
    const utf8 = (flags & 0x100) !== 0;
    const start = at + u32(at + 20, end);
    const styleOffset = u32(at + 24, end);
    const stop = styleOffset === 0 ? end : at + styleOffset;
    if (count === 0 && styles === 0 && start === at && styleOffset === 0 && end === at + header)
      return [];
    if (
      count > 100_000 ||
      styles > count ||
      start < at + header + (count + styles) * 4 ||
      start > stop ||
      stop > end ||
      (styles > 0 && styleOffset === 0) ||
      (!utf8 && start % 2) ||
      stop % 4
    )
      invalid();
    const strings: string[] = [];
    for (let i = 0; i < count; i++) {
      tick();
      let pos = start + u32(at + header + i * 4, start);
      if (pos < start || pos >= stop || (!utf8 && pos % 2)) invalid();
      const length = (): number => {
        if (utf8) {
          if (pos >= stop) return invalid();
          const first = bytes[pos++]!;
          if (!(first & 0x80)) return first;
          if (pos >= stop) return invalid();
          return ((first & 0x7f) << 8) | bytes[pos++]!;
        }
        const first = u16(pos, stop);
        pos += 2;
        if (!(first & 0x8000)) return first;
        const second = u16(pos, stop);
        pos += 2;
        return (first & 0x7fff) * 65536 + second;
      };
      const units = length();
      const size = utf8 ? length() : units * 2;
      const valueEnd = pos + size;
      if (valueEnd + (utf8 ? 1 : 2) > stop) invalid();
      if (utf8 ? bytes[valueEnd] !== 0 : u16(valueEnd, stop) !== 0) invalid();
      decodedSize += units;
      if (decodedSize > 256 * 1024 * 1024) invalid();
      const value = bytes.subarray(pos, valueEnd).toString(utf8 ? 'utf8' : 'utf16le');
      if (
        value.length !== units ||
        (utf8 && !Buffer.from(value, 'utf8').equals(bytes.subarray(pos, valueEnd)))
      )
        invalid();
      strings.push(value);
    }
    // 样式不是秘密值，但其长度和索引仍须有效，不能绕过损坏检查。
    for (let i = 0; i < styles; i++) {
      tick();
      const offset = u32(at + header + (count + i) * 4, start);
      if (offset === NONE) continue;
      let pos = stop + offset;
      if (offset % 4 || pos < stop || pos >= end) invalid();
      while (u32(pos, end) !== NONE) {
        tick();
        get(strings, u32(pos, end));
        const first = u32(pos + 4, end);
        const last = u32(pos + 8, end);
        if (first > last || last >= get(strings, i).length) invalid();
        pos += 12;
      }
    }
    return strings;
  };

  const root = chunk(0, bytes.length);
  if (root.type !== 2 || root.header !== 12 || root.end !== bytes.length) invalid();
  const top = children(root);
  const globals = top.filter((c) => c.type === 1);
  const packages = top.filter((c) => c.type === 0x0200);
  if (
    globals.length !== 1 ||
    packages.length !== u32(8, root.end) ||
    top.length !== packages.length + 1
  )
    invalid();
  const values = pool(globals[0]!);
  const allPools = [values];
  const entries: Entry[] = [];
  const byId = new Map<number, Entry[]>();
  const typed = (type: number, data: number, entry: Entry): void => {
    tick();
    if (type === 3) entry.values.push({ kind: 'text', text: get(values, data) });
    else if (type >= 0x10 && type <= 0x1f)
      entry.values.push({ kind: 'number', text: String(data) });
    // TYPE_REFERENCE / TYPE_DYNAMIC_REFERENCE；资源 ID 0 是 @null，没有取值。
    else if ((type === 1 || type === 7) && data !== 0) entry.values.push({ kind: 'ref', id: data });
    else if (type > 8) invalid();
  };
  const valueAt = (at: number, end: number, entry: Entry): void => {
    if (u16(at, end) !== 8 || bytes[at + 2] !== 0) invalid();
    const data = u32(at + 4, end);
    typed(bytes[at + 3]!, data, entry);
  };
  const readType = (
    c: Chunk,
    pkgId: number,
    keys: string[],
    types: string[],
    specCount?: number,
  ): void => {
    const { at, header, end } = c;
    if (header < 24 || bytes[at + 8] === 0 || u16(at + 10, end) !== 0) invalid();
    const typeId = bytes[at + 8]!;
    const typeName = get(types, typeId - 1);
    const flags = bytes[at + 9]!;
    if (flags !== 0 && flags !== 1 && flags !== 2) invalid();
    const count = u32(at + 12, end);
    const start = at + u32(at + 16, end);
    const configSize = u32(at + 20, end);
    const width = flags === 2 ? 2 : 4;
    if (
      configSize < 4 ||
      configSize !== header - 20 ||
      count > 65536 ||
      start < at + header + count * width ||
      start > end ||
      start % 4 ||
      (flags !== 1 && specCount !== undefined && count > specCount)
    )
      invalid();
    // 偏移 → 共用该 entry 的条目序号（资源 ID 低 16 位）。
    const offsets = new Map<number, number[]>();
    let previousId = -1;
    for (let i = 0; i < count; i++) {
      tick();
      const pos = at + header + i * width;
      let offset: number;
      let index = i;
      if (flags === 1) {
        const id = u16(pos, start);
        if (id <= previousId || (specCount !== undefined && id >= specCount)) invalid();
        previousId = id;
        index = id;
        offset = u16(pos + 2, start) * 4;
      } else if (flags === 2) {
        const short = u16(pos, start);
        if (short === 0xffff) continue;
        offset = short * 4;
      } else {
        offset = u32(pos, start);
        if (offset === NONE) continue;
      }
      if (offset % 4 || start + offset + 8 > end) invalid();
      // aapt2 可让多个资源 ID 共用同一个 entry；只解析一次，不把合法别名当损坏。
      const shared = offsets.get(offset);
      if (shared) shared.push(index);
      else offsets.set(offset, [index]);
    }
    const ordered = [...offsets.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i++) {
      tick();
      const base = start + ordered[i]!;
      const limit = i + 1 < ordered.length ? start + ordered[i + 1]! : end;
      const entryFlags = u16(base + 2, limit);
      let entry: Entry;
      if (entryFlags & 8) {
        if ((entryFlags & 0xff & ~0x0e) !== 0) invalid();
        entry = { key: get(keys, u16(base, limit)), type: typeName, values: [] };
        typed(entryFlags >>> 8, u32(base + 4, limit), entry);
      } else {
        if ((entryFlags & ~7) !== 0) invalid();
        const size = u16(base, limit);
        if (size < 8 || size % 4 || base + size > limit) invalid();
        entry = { key: get(keys, u32(base + 4, limit)), type: typeName, values: [] };
        if (entryFlags & 1) {
          if (size < 16) invalid();
          const items = u32(base + 12, limit);
          if (items > 100_000 || base + size + items * 12 > limit) invalid();
          for (let j = 0; j < items; j++) valueAt(base + size + j * 12 + 4, limit, entry);
        } else valueAt(base + size, limit, entry);
      }
      entries.push(entry);
      for (const index of offsets.get(ordered[i]!)!) {
        const id = ((pkgId << 24) | (typeId << 16) | index) >>> 0;
        const configs = byId.get(id);
        if (configs) configs.push(entry);
        else byId.set(id, [entry]);
      }
    }
  };

  for (const pkg of packages) {
    if (pkg.header !== 284 && pkg.header !== 288) invalid();
    const pkgId = u32(pkg.at + 8, pkg.end);
    if (pkgId > 255) invalid();
    const parts = children(pkg);
    const typeOffset = u32(pkg.at + 268, pkg.end);
    const keyOffset = u32(pkg.at + 276, pkg.end);
    const typePool = parts.find((c) => c.at === pkg.at + typeOffset);
    const keyPool = parts.find((c) => c.at === pkg.at + keyOffset);
    // 没有本包键名池的继承包无法独立解释，不能按孤立字符串扫描后放行。
    if (!typePool || !keyPool || typePool === keyPool) invalid();
    const types = pool(typePool!);
    const keys = pool(keyPool!);
    allPools.push(types, keys);
    if (u32(pkg.at + 272, pkg.end) > types.length || u32(pkg.at + 280, pkg.end) > keys.length)
      invalid();
    const specs = new Map<number, number>();
    for (const c of parts) {
      if (c.type !== 0x0202) continue;
      if (c.header !== 16 || bytes[c.at + 9] !== 0) invalid();
      const id = bytes[c.at + 8]!;
      get(types, id - 1);
      const count = u32(c.at + 12, c.end);
      if (count > 65536 || c.at + c.header + count * 4 !== c.end || specs.has(id)) invalid();
      specs.set(id, count);
    }
    for (const c of parts) {
      if (c === typePool || c === keyPool || c.type === 0x0202) continue;
      if (c.type === 0x0201) {
        readType(c, pkgId, keys, types, specs.get(bytes[c.at + 8]!));
      } else if (c.type === 0x0203 || c.type === 0x0206) {
        // shared-library / staged-alias 元数据只有固定宽度记录。
        if (c.header !== 12) invalid();
        const width = c.type === 0x0203 ? 260 : 8;
        if (c.at + c.header + u32(c.at + 8, c.end) * width !== c.end) invalid();
      } else if (c.type === 0x0204) {
        if (c.header !== 1032) invalid();
        for (const policy of children(c)) {
          if (
            policy.type !== 0x0205 ||
            policy.header !== 16 ||
            policy.at + policy.header + u32(policy.at + 12, policy.end) * 4 !== policy.end
          )
            invalid();
        }
      } else invalid();
    }
  }
  // 引用链按资源 ID 解析到最终取值（各配置都算），限深防环；最终取值以引用方的字段名检测。
  const memo = new Map<number, Resolved>();
  const visiting = new Set<number>();
  const resolve = (id: number): Resolved => {
    tick();
    const known = memo.get(id);
    if (known) return known;
    const configs = byId.get(id);
    // 本表之外（如框架资源）、成环或超过深度的引用都算解析不了。
    if (!configs || visiting.has(id) || visiting.size >= MAX_REFERENCE_DEPTH) {
      return { finals: [], ok: false, partial: !!configs };
    }
    visiting.add(id);
    const finals: Final[] = [];
    let ok = true;
    let partial = false;
    for (const target of configs) {
      for (const value of target.values) {
        if (value.kind !== 'ref') {
          finals.push({ text: value.text, file: fileValue(target, value) });
          continue;
        }
        const next = resolve(value.id);
        for (const final of next.finals) finals.push(final);
        ok &&= next.ok;
        partial ||= next.partial;
        if (finals.length > 100_000) invalid();
      }
    }
    visiting.delete(id);
    const result = { finals, ok, partial };
    // 因深度截断得到的结果与入口有关，不缓存。
    if (!partial) memo.set(id, result);
    return result;
  };
  for (const entry of entries) {
    for (const value of entry.values) {
      if (value.kind !== 'ref') {
        if (fileValue(entry, value)) emit(value.text);
        else emit(value.text, entry.key);
        continue;
      }
      const resolved = resolve(value.id);
      // 样式与属性定义的条目项常引用框架资源（本表之外），名字是主题名而不是字段，不配键名。
      const keyless = FILE_TYPES.has(entry.type) || STRUCTURE_TYPES.has(entry.type);
      // 签名材料字段的引用解析不了时不能当成没有取值放行（fail-closed）。
      if (!resolved.ok && !keyless && fieldRule(entry.key) === 'request-sign-material') invalid();
      for (const final of resolved.finals) {
        if (final.file || keyless) emit(final.text);
        else emit(final.text, entry.key);
      }
    }
  }
  // 没被字段引用的字符串也检测，引用过的值避免重复产生降级命中。
  for (const strings of allPools) for (const value of strings) if (!used.has(value)) emit(value);
  return lines.join('\n');
}

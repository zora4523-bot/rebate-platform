interface Chunk {
  at: number;
  type: number;
  header: number;
  end: number;
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
  const lines: string[] = [];
  const emit = (value: string, key?: string): void => {
    const line =
      key === undefined ? JSON.stringify(value) : `${JSON.stringify(key)}:${JSON.stringify(value)}`;
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
  const typed = (type: number, data: number, key: string): void => {
    tick();
    if (type === 3) emit(get(values, data), key);
    else if (type >= 0x10 && type <= 0x1f) emit(String(data), key);
    else if (type > 8) invalid();
  };
  const valueAt = (at: number, end: number, key: string): void => {
    if (u16(at, end) !== 8 || bytes[at + 2] !== 0) invalid();
    const data = u32(at + 4, end);
    typed(bytes[at + 3]!, data, key);
  };
  const readType = (c: Chunk, keys: string[], types: string[], specCount?: number): void => {
    const { at, header, end } = c;
    if (header < 24 || bytes[at + 8] === 0 || u16(at + 10, end) !== 0) invalid();
    get(types, bytes[at + 8]! - 1);
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
    const offsets = new Set<number>();
    let previousId = -1;
    for (let i = 0; i < count; i++) {
      tick();
      const pos = at + header + i * width;
      let offset: number;
      if (flags === 1) {
        const id = u16(pos, start);
        if (id <= previousId || (specCount !== undefined && id >= specCount)) invalid();
        previousId = id;
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
      offsets.add(offset);
    }
    const ordered = [...offsets].sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i++) {
      tick();
      const entry = start + ordered[i]!;
      const limit = i + 1 < ordered.length ? start + ordered[i + 1]! : end;
      const entryFlags = u16(entry + 2, limit);
      if (entryFlags & 8) {
        if ((entryFlags & 0xff & ~0x0e) !== 0) invalid();
        const key = get(keys, u16(entry, limit));
        typed(entryFlags >>> 8, u32(entry + 4, limit), key);
        continue;
      }
      if ((entryFlags & ~7) !== 0) invalid();
      const size = u16(entry, limit);
      if (size < 8 || size % 4 || entry + size > limit) invalid();
      const key = get(keys, u32(entry + 4, limit));
      if (entryFlags & 1) {
        if (size < 16) invalid();
        const count = u32(entry + 12, limit);
        if (count > 100_000 || entry + size + count * 12 > limit) invalid();
        for (let j = 0; j < count; j++) valueAt(entry + size + j * 12 + 4, limit, key);
      } else valueAt(entry + size, limit, key);
    }
  };

  for (const pkg of packages) {
    if (pkg.header !== 284 && pkg.header !== 288) invalid();
    if (u32(pkg.at + 8, pkg.end) > 255) invalid();
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
        readType(c, keys, types, specs.get(bytes[c.at + 8]!));
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
  // 没被字段引用的字符串也检测，引用过的值避免重复产生降级命中。
  for (const strings of allPools) for (const value of strings) if (!used.has(value)) emit(value);
  return lines.join('\n');
}

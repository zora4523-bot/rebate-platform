/** Android ResXMLTree：只恢复字符串及属性关系，不执行资源或解析外部引用。 */
export function axmlText(bytes: Buffer): string {
  const invalid = (): never => {
    throw new Error('Invalid binary Android XML');
  };
  const u16 = (at: number, limit = bytes.length): number => {
    if (at < 0 || at + 2 > limit) return invalid();
    return bytes.readUInt16LE(at);
  };
  const u32 = (at: number, limit = bytes.length): number => {
    if (at < 0 || at + 4 > limit) return invalid();
    return bytes.readUInt32LE(at);
  };
  if (u16(0) !== 3 || u16(2) !== 8 || u32(4) !== bytes.length) invalid();
  const NONE = 0xffffffff;
  let strings: string[] | undefined;
  const used = new Set<string>();
  const lines: string[] = [];
  let outputSize = 0;
  const emit = (value: string, key?: string): void => {
    used.add(value);
    if (key !== undefined) used.add(key);
    const line =
      key === undefined ? JSON.stringify(value) : `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    outputSize += line.length;
    if (outputSize > 256 * 1024 * 1024 || lines.length >= 200_000) invalid();
    lines.push(line);
  };
  const str = (ref: number): string => strings?.[ref] ?? invalid();
  const optional = (ref: number): void => {
    if (ref !== NONE) str(ref);
  };
  const stack: Array<[number, number]> = [];
  let elements = 0;
  let chunks = 0;
  for (let at = 8; at < bytes.length;) {
    if (++chunks > 200_000) invalid();
    const type = u16(at);
    const header = u16(at + 2);
    const size = u32(at + 4);
    const end = at + size;
    if (header < 8 || size < header || end > bytes.length || size % 4 !== 0) invalid();
    if (type === 1) {
      if (strings || header < 28) invalid();
      const count = u32(at + 8, end);
      const styles = u32(at + 12, end);
      const utf8 = (u32(at + 16, end) & 0x100) !== 0;
      const start = at + u32(at + 20, end);
      const styleOffset = u32(at + 24, end);
      const stop = styleOffset === 0 ? end : at + styleOffset;
      if (
        count > 100_000 ||
        styles > count ||
        start < at + header + (count + styles) * 4 ||
        start > stop ||
        stop > end ||
        (styles > 0 && styleOffset === 0)
      )
        invalid();
      strings = [];
      let decodedSize = 0;
      for (let i = 0; i < count; i++) {
        let pos = start + u32(at + header + i * 4, start);
        if (pos < start || pos >= stop) invalid();
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
        const byteLength = utf8 ? length() : units * 2;
        const valueEnd = pos + byteLength;
        if (valueEnd + (utf8 ? 1 : 2) > stop) invalid();
        if (utf8 ? bytes[valueEnd] !== 0 : u16(valueEnd, stop) !== 0) invalid();
        const value = bytes.subarray(pos, valueEnd).toString(utf8 ? 'utf8' : 'utf16le');
        if (
          value.length !== units ||
          (utf8 && !Buffer.from(value, 'utf8').equals(bytes.subarray(pos, valueEnd)))
        )
          invalid();
        decodedSize += value.length;
        if (decodedSize > 256 * 1024 * 1024) invalid();
        strings.push(value);
      }
    } else if (type === 0x0180) {
      // Resource map：资源 ID 不是字符串引用。
      if (!strings || (size - header) % 4 !== 0) invalid();
    } else {
      if (!strings || header < 16) invalid();
      optional(u32(at + 12, end)); // comment
      const ext = at + header;
      if (type === 0x0102) {
        const ns = u32(ext, end);
        const name = u32(ext + 4, end);
        optional(ns);
        str(name);
        const attrStart = u16(ext + 8, end);
        const attrSize = u16(ext + 10, end);
        const count = u16(ext + 12, end);
        if (attrStart < 20 || attrSize < 20 || ext + attrStart + count * attrSize > end) invalid();
        for (const offset of [14, 16, 18]) {
          if (u16(ext + offset, end) > count) invalid();
        }
        const attrs: Array<{ name: string; values: string[] }> = [];
        for (let i = 0; i < count; i++) {
          const attr = ext + attrStart + i * attrSize;
          optional(u32(attr, end));
          const key = str(u32(attr + 4, end));
          const raw = u32(attr + 8, end);
          if (u16(attr + 12, end) !== 8 || bytes[attr + 14] !== 0) invalid();
          const dataType = bytes[attr + 15]!;
          const data = u32(attr + 16, end);
          const values = new Set<string>();
          if (raw !== NONE) values.add(str(raw));
          if (dataType === 3) values.add(str(data));
          else if (dataType >= 0x10 && dataType <= 0x1f) values.add(String(data));
          attrs.push({ name: key, values: [...values] });
        }
        const names = attrs.filter((attr) => attr.name === 'name').flatMap((attr) => attr.values);
        for (const attr of attrs) {
          for (const value of attr.values) {
            if (attr.name === 'value' && names.length > 0) {
              for (const key of names) emit(value, key);
            } else emit(value, attr.name);
          }
        }
        stack.push([ns, name]);
        if (stack.length > 128 || ++elements > 100_000) invalid();
      } else if (type === 0x0103) {
        const ns = u32(ext, end);
        const name = u32(ext + 4, end);
        const start = stack.pop();
        if (!start || start[0] !== ns || start[1] !== name) invalid();
      } else if (type === 0x0100 || type === 0x0101) {
        optional(u32(ext, end));
        str(u32(ext + 4, end));
      } else if (type === 0x0104) {
        emit(str(u32(ext, end)));
        if (u16(ext + 4, end) !== 8 || bytes[ext + 6] !== 0) invalid();
        const data = u32(ext + 8, end);
        if (bytes[ext + 7] === 3) emit(str(data));
      } else invalid();
    }
    at = end;
  }
  if (!strings || stack.length > 0 || elements === 0) invalid();
  // 未引用的池字符串也扫描；已恢复成字段的值不重复输出。
  for (const value of strings ?? []) if (!used.has(value)) emit(value);
  return lines.join('\n');
}

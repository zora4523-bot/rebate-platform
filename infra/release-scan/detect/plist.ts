/** 二进制 plist 只解析数据，不加载类、不执行对象；所有偏移均校验边界。 */
export function plistText(bytes: Buffer): string {
  const invalid = (): never => {
    throw new Error('Invalid binary plist');
  };
  if (bytes.length < 40) invalid();
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6]!;
  const refSize = bytes[trailer + 7]!;
  const uint = (at: number, width: number, limit = trailer): number => {
    if (width < 1 || width > 8 || at < 0 || at + width > limit) return invalid();
    let value = 0n;
    for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[at + i]!);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
    return Number(value);
  };
  const count = uint(trailer + 8, 8, bytes.length);
  const top = uint(trailer + 16, 8, bytes.length);
  const table = uint(trailer + 24, 8, bytes.length);
  if (
    count < 1 ||
    count > 100_000 ||
    top >= count ||
    refSize < 1 ||
    refSize > 8 ||
    offsetSize < 1 ||
    offsetSize > 8 ||
    table < 8 ||
    table + count * offsetSize !== trailer
  )
    invalid();
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offsetSize, offsetSize));
  if (offsets.some((offset) => offset < 8 || offset >= table) || new Set(offsets).size !== count)
    invalid();
  const ordered = [...offsets].sort((a, b) => a - b);
  const limits = new Map(ordered.map((at, i) => [at, ordered[i + 1] ?? table]));
  const cache = new Map<number, unknown>();
  const active = new Set<number>();
  let visits = 0;
  const parse = (ref: number, depth: number): unknown => {
    if (ref >= count || depth > 64 || ++visits > 200_000 || active.has(ref)) return invalid();
    if (cache.has(ref)) return cache.get(ref);
    active.add(ref);
    let at = offsets[ref]!;
    const limit = limits.get(at)!;
    const marker = bytes[at++]!;
    const kind = marker >> 4;
    let size = marker & 15;
    if (kind >= 4 && kind !== 8 && size === 15) {
      const lengthMarker = bytes[at++];
      if (lengthMarker === undefined || lengthMarker >> 4 !== 1) return invalid();
      const width = 2 ** (lengthMarker & 15);
      size = uint(at, width, limit);
      at += width;
    }
    const body = (length: number): Buffer => {
      if (!Number.isSafeInteger(length) || at + length > limit) return invalid();
      return bytes.subarray(at, at + length);
    };
    const reference = (index: number): number => uint(at + index * refSize, refSize, limit);
    let value: unknown;
    switch (kind) {
      case 0:
        if (![0, 8, 9, 15].includes(size)) return invalid();
        value = size === 8 ? false : size === 9 ? true : null;
        break;
      case 1: {
        const data = body(2 ** size);
        if (data.length > 16) return invalid();
        let integer = 0n;
        for (const byte of data) integer = (integer << 8n) | BigInt(byte);
        value = integer.toString();
        break;
      }
      case 2: {
        const data = body(2 ** size);
        if (data.length !== 4 && data.length !== 8) return invalid();
        value = data.length === 4 ? data.readFloatBE() : data.readDoubleBE();
        break;
      }
      case 3:
        if (size !== 3) return invalid();
        value = body(8).readDoubleBE();
        break;
      case 4:
        // data 也可能藏有签名材料，保留可读字节和 base64 两种视图。
        value = body(size);
        break;
      case 5:
        value = body(size).toString('latin1');
        break;
      case 6:
        value = Buffer.from(body(size * 2))
          .swap16()
          .toString('utf16le');
        break;
      case 7:
        value = body(size).toString('utf8');
        break;
      case 8:
        value = body(size + 1).toString('hex');
        break;
      case 10:
      case 11:
      case 12:
        body(size * refSize);
        value = Array.from({ length: size }, (_, i) => parse(reference(i), depth + 1));
        break;
      case 13: {
        body(size * refSize * 2);
        // 用键值对数组保存重复键，避免后一个覆盖前一个后漏扫。
        const pairs: unknown[] = [];
        for (let i = 0; i < size; i++) {
          const key = parse(reference(i), depth + 1);
          if (typeof key !== 'string') return invalid();
          pairs.push({ [key]: parse(reference(size + i), depth + 1) });
        }
        value = pairs;
        break;
      }
      default:
        return invalid();
    }
    active.delete(ref);
    cache.set(ref, value);
    return value;
  };
  // 扫描所有对象（包括未被根引用的对象），JSON 保留字段和值之间的关系。
  // 分对象输出，避免共享引用展开造成指数级内存消耗。
  parse(top, 0);
  for (let ref = 0; ref < count; ref++) parse(ref, 0);
  const seen = new Map<object, Set<string | undefined>>();
  const emitted = new Set<string>();
  const lines: string[] = [];
  let emissions = 0;
  const scalar = (value: unknown, key?: string): void => {
    if (++emissions > 200_000) invalid();
    if (key !== undefined) emitted.add(key);
    if (typeof value === 'string') emitted.add(value);
    lines.push(
      key === undefined ? JSON.stringify(value) : `${JSON.stringify(key)}:${JSON.stringify(value)}`,
    );
  };
  const emit = (value: unknown, parent?: string): void => {
    if (value && typeof value === 'object') {
      const contexts = seen.get(value) ?? new Set<string | undefined>();
      if (contexts.has(parent)) return;
      contexts.add(parent);
      seen.set(value, contexts);
      if (++emissions > 200_000) invalid();
      if (Buffer.isBuffer(value)) {
        scalar(value.toString('latin1'), parent);
        scalar(value.toString('base64'), parent);
      } else if (Array.isArray(value)) value.forEach((child) => emit(child, parent));
      else
        for (const [key, child] of Object.entries(value)) {
          emit(child, key);
        }
    } else scalar(value, parent);
  };
  emit(cache.get(top));
  for (const value of cache.values()) {
    if (value && typeof value === 'object' && !seen.has(value)) emit(value);
  }
  // 独立的字符串也要扫；已出现在键值对中的字符串不重复报。
  for (const value of cache.values()) {
    if (typeof value === 'string' && !emitted.has(value)) scalar(value);
  }
  return lines.join('\n');
}

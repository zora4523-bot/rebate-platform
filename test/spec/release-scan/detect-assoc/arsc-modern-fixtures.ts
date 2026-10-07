import { chunk, stringPool, u16, u32 } from './android-fixtures.ts';

export interface PoolSpan {
  first: number;
  last: number;
}

/**
 * ResStringPool_header + stringOffsets + 可选 styleOffsets + UTF-16 串 + ResStringPool_span。
 * span.name=1 指向第二个字符串 "b"；styleOffsets[0]=0；END=0xffffffff。
 * https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/androidfw/include/androidfw/ResourceTypes.h
 * 大表用连续 Buffer 写入，避免 ...100000 个函数实参引发 RangeError。
 */
function globalPool(count: number, span?: PoolSpan): Buffer {
  const styleCount = span === undefined ? 0 : 1;
  const start = 28 + 4 * (count + styleCount);
  // 每个短串 UTF-16 长度1：length=1, 字符, NUL 共6字节；末串 Demo 为12字节。
  const dataLength = (count - 1) * 6 + 12;
  const paddedLength = (dataLength + 3) & ~3;
  const stylesAt = start + paddedLength;
  const bytes = Buffer.alloc(stylesAt + (span === undefined ? 0 : 24));
  bytes.writeUInt16LE(1, 0);
  bytes.writeUInt16LE(28, 2);
  bytes.writeUInt32LE(bytes.length, 4);
  bytes.writeUInt32LE(count, 8);
  bytes.writeUInt32LE(styleCount, 12);
  bytes.writeUInt32LE(start, 20);
  bytes.writeUInt32LE(span === undefined ? 0 : stylesAt, 24);
  for (let i = 0; i < count; i++) {
    const at = start + i * 6;
    bytes.writeUInt32LE(i * 6, 28 + i * 4);
    const value = i === count - 1 ? 'Demo' : i === 1 ? 'b' : 'a';
    bytes.writeUInt16LE(value.length, at);
    bytes.write(value, at + 2, 'utf16le');
  }
  if (span !== undefined) {
    bytes.writeUInt32LE(0, 28 + count * 4);
    bytes.writeUInt32LE(1, stylesAt);
    bytes.writeUInt32LE(span.first, stylesAt + 4);
    bytes.writeUInt32LE(span.last, stylesAt + 8);
    bytes.fill(0xff, stylesAt + 12, stylesAt + 24);
  }
  return bytes;
}

/** 一个 string/label 条目指向全局串池最后一项，明确验证不是截断到前10万串。 */
export function modernArsc(
  options: { count?: number; entryFlags?: number; span?: PoolSpan } = {},
): Buffer {
  const count = options.count ?? 3;
  const globals = globalPool(count, options.span);
  const types = stringPool(['string']);
  const keys = stringPool(['label']);
  const config = Buffer.alloc(64);
  config.writeUInt32LE(64);
  const entry = Buffer.concat([
    u16(8),
    u16(options.entryFlags ?? 0),
    u32(0),
    u16(8),
    Buffer.from([0, 3]),
    u32(count - 1),
  ]);
  const type = chunk(0x0201, 84, Buffer.from([1, 0, 0, 0]), u32(1, 88), config, u32(0), entry);
  const spec = chunk(0x0202, 16, Buffer.from([1, 0, 0, 0]), u32(1, 0));
  const header = Buffer.alloc(280);
  header.writeUInt32LE(0x7f, 0);
  header.write('com.example.demo', 4, 'utf16le');
  header.writeUInt32LE(288, 260);
  header.writeUInt32LE(1, 264);
  header.writeUInt32LE(288 + types.length, 268);
  header.writeUInt32LE(1, 272);
  return chunk(2, 12, u32(1), globals, chunk(0x0200, 288, header, types, keys, spec, type));
}

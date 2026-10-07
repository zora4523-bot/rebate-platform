import { plistText } from './plist.ts';

/** BOM 文本只扫描解码视图；普通二进制扫描 latin1 以及无 BOM 的 UTF-16LE 串。 */
export function textViews(content: string | Uint8Array): string[] {
  if (typeof content === 'string') return [content];
  const bytes = Buffer.from(content);
  if (bytes.subarray(0, 8).toString('ascii') === 'bplist00') return [plistText(bytes)];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2) throw new Error('Truncated UTF-16 text');
    return [bytes.subarray(2).toString('utf16le')];
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2) throw new Error('Truncated UTF-16 text');
    return [Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')];
  }
  const views = [bytes.toString('latin1')];
  // 两种对齐都检查；只提取可打印 ASCII 和换行、制表符，不把控制码当字段。
  for (let start = 0; start + 1 < bytes.length; start++) {
    let end = start;
    while (
      end + 1 < bytes.length &&
      bytes[end + 1] === 0 &&
      ((bytes[end]! >= 32 && bytes[end]! <= 126) || [9, 10, 13].includes(bytes[end]!))
    )
      end += 2;
    if (end - start >= 8) {
      views.push(bytes.subarray(start, end).toString('utf16le'));
      start = end - 1;
    }
  }
  return views;
}

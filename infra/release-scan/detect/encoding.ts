import { plistText } from './plist.ts';
import { axmlText } from './axml.ts';
import { arscText } from './arsc.ts';
import { rawStrings } from './raw-strings.ts';

/** arsc 等二进制可含同样的短字节前缀；完整 XML 容器或 XML 文件才走 AXML（textViews 与关联视图共用这一判定）。 */
export function axmlContent(content: Uint8Array, file: string): boolean {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return (
    bytes.length >= 2 &&
    bytes.readUInt16LE(0) === 3 &&
    (/\.xml$/i.test(file) || (bytes.length >= 8 && bytes.readUInt32LE(4) === bytes.length))
  );
}

/** 内容检测也接受普通二进制片段；完整制品中的资源表则连损坏的类型头也必须拒绝。 */
function arscContent(bytes: Buffer, file: string, completeArtifact: boolean): boolean {
  return (
    /(?:^|\/)resources\.arsc$/i.test(file) &&
    (completeArtifact || (bytes.length >= 2 && bytes.readUInt16LE(0) === 2))
  );
}

/** 一个文本视图；rawStrings 标出 AXML 的原值视图（NUL 分隔的解码字符串）。 */
export interface TextView {
  text: string;
  rawStrings?: boolean;
}

/**
 * 同 textViews，另标出原值视图：detectSecrets 据此对原值视图按独立串检测，并与 scanArtifact 同口径
 * 去掉原值视图里重复的 high-entropy 命中。
 */
export function textViewEntries(
  content: string | Uint8Array,
  file: string,
  completeArtifact = false,
): TextView[] {
  if (typeof content === 'string') return [{ text: content }];
  const bytes = Buffer.from(content);
  if (!arscContent(bytes, file, completeArtifact) && axmlContent(bytes, file)) {
    // AXML（清单与 res/xml/*.xml）：JSON 键值视图之外另给原值视图。文本节点 / CDATA / 属性里含引号的
    // `shared_salt="…"` 在 JSON 视图里被转义，只有原值视图能按字段检出；所有调用方（scanArtifact、
    // 命令行的 secretTextViews、残留检测）都经这里拿到它。只加视图，不删视图。
    const text = axmlText(bytes);
    const raw = rawStrings(text);
    return raw === undefined ? [{ text }] : [{ text }, { text: raw, rawStrings: true }];
  }
  return textViews(bytes, file, completeArtifact).map((text) => ({ text }));
}

/** BOM 文本只扫描解码视图；普通二进制扫描 latin1 以及无 BOM 的 UTF-16LE 串。 */
export function textViews(
  content: string | Uint8Array,
  file: string,
  completeArtifact = false,
): string[] {
  if (typeof content === 'string') return [content];
  const bytes = Buffer.from(content);
  if (arscContent(bytes, file, completeArtifact)) return [arscText(bytes)];
  if (axmlContent(bytes, file)) return textViewEntries(bytes, file).map((view) => view.text);
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

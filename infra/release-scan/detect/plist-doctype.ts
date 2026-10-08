/**
 * Apple XML plist 的完整标准 DOCTYPE 声明（公开 DTD 地址，不是取值）。只认逐字符一致的整条声明：
 * 改动过的标识或地址、带内部子集（`[...]`）的声明都不匹配，照常检测。
 */
const PLIST_DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

/** 声明前紧接 XML 声明（中间只有空白）。 */
const XML_DECLARATION_BEFORE = /<\?xml\b[^<>]*\?>\s*$/;
/** 声明后（可隔空白）紧接根元素 `<plist`。 */
const PLIST_ROOT_AFTER = /^\s*<plist\b/;
const WINDOW = 1024;

/**
 * 按结构识别 XML plist 的标准 DOCTYPE，并用等长空格替换：偏移与行号不变，同一行声明前后的内容照常检测。
 * 结构 = 声明位于文本开头（可带 BOM、前导空白）或紧跟 XML 声明，且其后紧接 `<plist` 根元素。
 * 不看文件扩展名：签名 ipa 里 CMS 包裹的 embedded.mobileprovision 中的 plist 同样适用。
 */
export function maskPlistDoctype(text: string): string {
  let at = text.indexOf(PLIST_DOCTYPE);
  if (at < 0) return text;
  let out = '';
  let from = 0;
  while (at >= 0) {
    const end = at + PLIST_DOCTYPE.length;
    const atStart = at <= WINDOW && /^﻿?\s*$/.test(text.slice(0, at));
    const afterDeclaration = XML_DECLARATION_BEFORE.test(text.slice(Math.max(0, at - WINDOW), at));
    if ((atStart || afterDeclaration) && PLIST_ROOT_AFTER.test(text.slice(end, end + WINDOW))) {
      out += text.slice(from, at) + ' '.repeat(PLIST_DOCTYPE.length);
      from = end;
    }
    at = text.indexOf(PLIST_DOCTYPE, end);
  }
  return out + text.slice(from);
}

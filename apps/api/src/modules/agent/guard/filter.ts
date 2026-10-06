// BR-AI-06 细则「过滤正则」: outbound text filter. Written from 08 independently of
// packages/evals; the detection surface also covers the grader's stricter forms (塊 圓 圆,
// traditional and financial numerals, every currency symbol as a passcode wrapper, NFKC).
export type FilterHit = 'amount' | 'url' | 'tpwd';

export const AMOUNT_PLACEHOLDER = '见卡片';

interface Span {
  start: number;
  end: number;
  kind: FilterHit;
  /** For 复制…打开X: where 打开X starts; a match that began in delivered text loses only that. */
  open?: number | undefined;
}

const CN = '零〇一二两兩三四五六七八九十百千万萬亿億壹贰貳叁叄參肆伍陆陸柒捌玖拾佰仟';
const NUM = String.raw`\d+(?:\.\d+)?`;
const AMOUNT_PATTERNS: readonly RegExp[] = [
  new RegExp(`[¥￥]\\s*${NUM}`, 'gu'),
  new RegExp(`(?<!\\d)${NUM}\\s*(?:元|块|塊|圓|圆|毛|角|折|%|％)`, 'gu'),
  new RegExp(`(?<![${CN}])[${CN}]+\\s*(?:元|块|塊|圓|圆)`, 'gu'),
  new RegExp(`(?:立减|到手|返|省|减|券)\\s*${NUM}`, 'gu'),
  /满\s*\d+\s*减/gu,
];

// URL characters: the full RFC 3986 ASCII set (unreserved, gen-delims, sub-delims and %), so a
// link is deleted whole (O-G3). Prose punctuation is told apart afterwards: only a trailing run
// of it (and an unbalanced closing bracket) is given back to the text.
const U = String.raw`[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]`;
const TLD = '(?:com|cn|net|top|cc|vip)';
const SCHEME = new RegExp(String.raw`(?<![A-Za-z0-9+.\-])[A-Za-z0-9+.\-]+:\/\/${U}*`, 'gu');
const WWW = new RegExp(String.raw`www\.${U}*`, 'giu');
const DOMAIN = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}\-])((?:[\p{L}\p{N}\p{M}\-]+\.)+${TLD})(?![A-Za-z0-9\-])(?:[/?#:]${U}*)?`,
  'giu',
);
const TRAILING_PUNCT = /[.,:;!?'*~]$/u;
const ASCII_HOST_CHAR = /[A-Za-z0-9.\-]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/u;

const TPWD_PATTERNS: readonly RegExp[] = [
  /([\p{Sc}/])[A-Za-z0-9]{8,14}\1/gu,
  /[(（][A-Za-z0-9]{8,14}[)）]/gu,
];
const COPY_OPEN = /复制[\s\S]*?(打开(?:淘宝|京东|拼多多))/gu;
const OPEN_APP = /打开(?:淘宝|京东|拼多多)/gu;
const HORIZONTAL_SPACE = /^[\t\p{Zs}]$/u;

interface Folded {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
}

const foldCache = new Map<string, string>();
// CJK prose punctuation stays as is, so a fullwidth comma or bracket never extends a link.
const KEEP_UNFOLDED: ReadonlySet<string> = new Set('，；！？（）');

/** Per code point NFKC with a map back to the original UTF-16 offsets; null when unchanged. */
function fold(text: string): Folded | null {
  if (text.normalize('NFKC') === text) return null;
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  let offset = 0;
  for (const ch of text) {
    let folded = foldCache.get(ch);
    if (folded === undefined) {
      folded = KEEP_UNFOLDED.has(ch) ? ch : ch.normalize('NFKC');
      if (foldCache.size < 4096) foldCache.set(ch, folded);
    }
    for (let i = 0; i < folded.length; i += 1) {
      from.push(offset);
      to.push(offset + ch.length);
    }
    out += folded;
    offset += ch.length;
  }
  return { text: out, from, to };
}

function trimEnd(text: string, start: number, end: number, min: number): number {
  let e = end;
  for (;;) {
    if (e <= min) break;
    const ch = text.charAt(e - 1);
    if (TRAILING_PUNCT.test(ch)) {
      e -= 1;
      continue;
    }
    const open = ch === ')' ? '(' : ch === ']' ? '[' : '';
    if (open === '') break;
    const body = text.slice(start, e);
    if (body.split(open).length >= body.split(ch).length) break;
    e -= 1;
  }
  return Math.max(e, start + 1);
}

// O-G1: an amount hit covers the whole number next to it (digits, decimals, thousands commas,
// numerals and place-value words on both sides, as in 1万5千元). BR-AI-06「块 / 元」后角位从严
// (owner decision 2026-10-06): a hit ending in 块 or 元 also takes the one digit right after it
// (across horizontal space only), whatever follows that digit: one Chinese digit, or exactly one
// Arabic digit (either width) that is not followed by a point and a digit. So 9块3件 loses the 3.
const CN_SET: ReadonlySet<string> = new Set(CN);
const PLACE_SET: ReadonlySet<string> = new Set('十百千万萬亿億拾佰仟');
const JIAO_UNIT: ReadonlySet<string> = new Set('块塊元圓圆');
const JIAO_CN_DIGIT: ReadonlySet<string> = new Set('〇零一二两三四五六七八九');
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isNumeral = (ch: string): boolean => isDigit(ch) || CN_SET.has(ch);
const isAnyWidthDigit = (ch: string): boolean => isDigit(ch) || (ch >= '０' && ch <= '９');
const isPoint = (ch: string): boolean => ch === '.' || ch === '．';

/** End offset of the 角 digit after a 块 / 元 that ends at `i`, or `i` when there is none. */
function jiaoEnd(text: string, i: number): number {
  let k = i;
  while (k < text.length && HORIZONTAL_SPACE.test(text.charAt(k))) k += 1;
  const ch = text.charAt(k);
  if (JIAO_CN_DIGIT.has(ch)) return k + 1;
  if (!isAnyWidthDigit(ch)) return i;
  const next = text.charAt(k + 1);
  if (isAnyWidthDigit(next)) return i;
  if (isPoint(next) && isAnyWidthDigit(text.charAt(k + 2))) return i;
  return k + 1;
}

function threeDigitsAt(text: string, i: number): boolean {
  return (
    isDigit(text.charAt(i)) &&
    isDigit(text.charAt(i + 1)) &&
    isDigit(text.charAt(i + 2)) &&
    !isDigit(text.charAt(i + 3))
  );
}

function extendAmount(text: string, start: number, end: number): [number, number] {
  let s = start;
  for (;;) {
    const here = text.charAt(s);
    const before = text.charAt(s - 1);
    if (s === 0) break;
    if (CN_SET.has(here) && isNumeral(before)) s -= 1;
    else if (isDigit(here) && isDigit(before)) s -= 1;
    else if (isDigit(here) && PLACE_SET.has(before) && isNumeral(text.charAt(s - 2))) s -= 1;
    else if (isDigit(here) && before === '.' && isDigit(text.charAt(s - 2))) s -= 2;
    else if (before === ',' && isDigit(text.charAt(s - 2)) && threeDigitsAt(text, s)) s -= 2;
    else break;
  }
  let e = end;
  for (;;) {
    const last = text.charAt(e - 1);
    const next = text.charAt(e);
    if (e >= text.length) break;
    if (isDigit(last) && (isDigit(next) || PLACE_SET.has(next))) e += 1;
    else if (CN_SET.has(last) && isNumeral(next)) e += 1;
    else if (isDigit(last) && next === '.' && isDigit(text.charAt(e + 1))) e += 2;
    else if (isDigit(last) && next === ',' && threeDigitsAt(text, e + 1)) e += 4;
    else if (JIAO_UNIT.has(last)) {
      e = jiaoEnd(text, e);
      break;
    } else break;
  }
  return [s, e];
}

type Add = (start: number, end: number, kind: FilterHit, open?: number) => void;

function scanForm(text: string, add: Add): void {
  for (const pattern of AMOUNT_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const [s, e] = extendAmount(text, m.index, m.index + m[0].length);
      add(s, e, 'amount');
    }
  }
  for (const m of text.matchAll(SCHEME)) {
    const min = text.indexOf('://', m.index) + 3;
    add(m.index, trimEnd(text, m.index, m.index + m[0].length, min), 'url');
  }
  for (const m of text.matchAll(WWW)) {
    add(m.index, trimEnd(text, m.index, m.index + m[0].length, m.index + 4), 'url');
  }
  for (const m of text.matchAll(DOMAIN)) {
    const host = m[1] ?? '';
    const hostEnd = m.index + host.length;
    // Prefer the ASCII host before the suffix (好jd.com → jd.com) so CJK prose is kept.
    let k = host.length;
    while (k > 0 && ASCII_HOST_CHAR.test(host.charAt(k - 1))) k -= 1;
    const start = k > 0 && ASCII_ALNUM.test(host.charAt(k)) ? m.index + k : m.index;
    add(start, trimEnd(text, start, m.index + m[0].length, hostEnd), 'url');
  }
  for (const pattern of TPWD_PATTERNS) {
    for (const m of text.matchAll(pattern)) add(m.index, m.index + m[0].length, 'tpwd');
  }
  for (const m of text.matchAll(COPY_OPEN)) {
    const end = m.index + m[0].length;
    add(m.index, end, 'tpwd', end - (m[1] ?? '').length);
  }
}

/** All hit spans of `text` in its own UTF-16 offsets, from the raw and the NFKC form. */
function scan(text: string, copySeen: boolean): Span[] {
  const spans: Span[] = [];
  scanForm(text, (start, end, kind, open) => spans.push({ start, end, kind, open }));
  const folded = fold(text);
  if (folded !== null) {
    scanForm(folded.text, (start, end, kind, open) => {
      const s = folded.from[start];
      const e = folded.to[end - 1];
      const o = open === undefined ? undefined : folded.from[open];
      if (s !== undefined && e !== undefined) spans.push({ start: s, end: e, kind, open: o });
    });
  }
  if (copySeen) {
    for (const m of text.matchAll(OPEN_APP)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind: 'tpwd' });
    }
  }
  return spans;
}

function onlyHorizontalSpace(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (!HORIZONTAL_SPACE.test(text.charAt(i))) return false;
  }
  return true;
}

/**
 * Filters `segment` as it follows the already delivered `context`: hits that start in the
 * context are cut back to the segment, so the concatenation never forms a match. Amount hits
 * become one placeholder per adjacent group; URL, scheme and passcode hits are deleted, with
 * the horizontal space right before a hit.
 */
export function filterAfter(
  context: string,
  segment: string,
  copySeen: boolean,
): { text: string; hits: FilterHit[] } {
  const base = context.length;
  // The delivered text already ends with a placeholder (maybe and horizontal space): an amount
  // right at the start of this segment joins it instead of adding a second one.
  const joinsPlaceholder = context.replace(/[\t\p{Zs}]+$/u, '').endsWith(AMOUNT_PLACEHOLDER);
  let current = segment;
  let first = true;
  const hits: FilterHit[] = [];
  for (;;) {
    const whole = context + current;
    const spans = scan(whole, copySeen)
      .filter((span) => span.end > base)
      .map((span) => ({
        ...span,
        start: Math.max(
          span.start < base && span.open !== undefined ? span.open : span.start,
          base,
        ),
      }))
      .sort(
        (a, b) =>
          a.start - b.start ||
          b.end - a.end ||
          Number(a.kind === 'amount') - Number(b.kind === 'amount'),
      );
    if (spans.length === 0) break;
    // Deletion wins over an amount found wholly inside a URL, scheme or passcode hit (as in
    // ￥1234AbCd￥ or a %E5%85%83-encoded link): the whole string goes. An amount that only
    // partly overlaps one still turns the merged span into the placeholder, so no price leaks.
    const inside: boolean[] = [];
    let deleteEnd = -1;
    for (const span of spans) {
      if (span.kind === 'amount') inside.push(span.end <= deleteEnd);
      else {
        inside.push(false);
        deleteEnd = Math.max(deleteEnd, span.end);
      }
    }
    let out = '';
    let cursor = base;
    let index = 0;
    while (index < spans.length) {
      const head = spans[index] as Span;
      let start = head.start;
      let end = head.end;
      let amount = false;
      while (index < spans.length) {
        const span = spans[index] as Span;
        if (span.start > end && !onlyHorizontalSpace(whole, end, span.start)) break;
        end = Math.max(end, span.end);
        if (span.kind === 'amount' && inside[index] !== true) amount = true;
        if (!hits.includes(span.kind)) hits.push(span.kind);
        index += 1;
      }
      while (start > cursor && HORIZONTAL_SPACE.test(whole.charAt(start - 1))) start -= 1;
      const joined = first && joinsPlaceholder && start === base && cursor === base;
      out += whole.slice(cursor, start) + (amount && !joined ? AMOUNT_PLACEHOLDER : '');
      cursor = end;
    }
    first = false;
    current = out + whole.slice(cursor);
  }
  return { text: current, hits };
}

export function filterSegment(text: string): {
  readonly text: string;
  readonly hits: readonly FilterHit[];
} {
  return filterAfter('', text, false);
}

/** Hit spans of a raw buffer (raw and NFKC forms), for the sentence buffer's cut points. */
export function riskSpans(
  text: string,
): readonly { start: number; end: number; kind: FilterHit }[] {
  return scan(text, false);
}

// BR-AI-24 细则「规格比对」：spec 与标题都做 NFKC、去空白、中文数字转阿拉伯数字、单位归一后，
// 数值与单位都相同才算一致；只比对规格，不判断品类。

/**
 * BR-AI-24: 同义单位归一，不做升/毫升、千克/克之间的换算。
 *
 * 清单是封闭的：清单外的单位（如「公斤」「个」「片」）一律判为「规格待确认」——含这类规格的
 * spec 归一结果为 null，调用方据此判 spec_unconfirmed。扩展清单要先到 08 BR-AI-24 登记。
 */
export type SpecUnit = 'ml' | 'L' | 'g' | 'kg' | '盒' | '箱' | '袋' | '瓶' | '包' | '件';

/** 数值用十进制字符串保存；多规格按输入出现顺序保存。 */
export type NormalizedSpec = readonly { readonly value: string; readonly unit: SpecUnit }[];

interface Token {
  readonly value: string;
  /** 未识别单位时为 null。 */
  readonly unit: SpecUnit | null;
  /** 在 NFKC 文本中的起止位置（含数字与单位，左闭右开）。 */
  readonly start: number;
  readonly end: number;
}

/** 按「长的写法优先」排列，避免「千克」被读成「克」、「kg」被读成「g」。 */
const UNIT_SPELLINGS: readonly (readonly [string, SpecUnit])[] = [
  ['毫升', 'ml'],
  ['千克', 'kg'],
  ['ml', 'ml'],
  ['kg', 'kg'],
  ['升', 'L'],
  ['克', 'g'],
  ['l', 'L'],
  ['g', 'g'],
  ['盒', '盒'],
  ['箱', '箱'],
  ['袋', '袋'],
  ['瓶', '瓶'],
  ['包', '包'],
  ['件', '件'],
];

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_MULTIPLIERS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

const WHITESPACE = /\s/u;
const LATIN_LETTER = /[A-Za-z]/;

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isCnNumeral(ch: string | undefined): boolean {
  return ch !== undefined && (ch in CN_DIGITS || ch in CN_MULTIPLIERS || ch === '万');
}

/** 十进制字符串规范化：去整数部分前导零、去小数部分末尾零（「024」→「24」，「2.50」→「2.5」）。 */
function canonicalDecimal(raw: string): string {
  const [intPart = '', fracPart = ''] = raw.split('.');
  const int = intPart.replace(/^0+(?=\d)/, '');
  const frac = fracPart.replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
}

/**
 * 严格解析一段中文数字（十、百、千、万计数法，如「二十四」「一百零五」「两」）；
 * 结构不合法（如「一二十四」「百」）返回 null，由调用方从下一个字重新尝试。
 */
function parseCnNumber(run: string): number | null {
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  let lastMultiplier = Number.POSITIVE_INFINITY;
  let hasMultiplier = false;
  for (const ch of run) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      if (d === 0) {
        if (digit !== null) return null;
        continue;
      }
      if (digit !== null) return null;
      digit = d;
      continue;
    }
    if (ch === '万') {
      section += digit ?? 0;
      if (section === 0 || total > 0) return null;
      total = section * 10000;
      section = 0;
      digit = null;
      lastMultiplier = Number.POSITIVE_INFINITY;
      hasMultiplier = true;
      continue;
    }
    const m = CN_MULTIPLIERS[ch];
    if (m === undefined || m >= lastMultiplier) return null;
    const factor = digit ?? (m === 10 ? 1 : null);
    if (factor === null) return null;
    section += factor * m;
    digit = null;
    lastMultiplier = m;
    hasMultiplier = true;
  }
  if (!hasMultiplier && run.length > 1) return null;
  return total + section + (digit ?? 0);
}

/** 数字之后（可隔空白）的单位；拉丁字母单位后面不能紧跟字母（「64GB」不是 64g）。 */
function readUnit(text: string, from: number): { unit: SpecUnit; end: number } | null {
  let at = from;
  while (at < text.length && WHITESPACE.test(text[at] ?? '')) at += 1;
  const rest = text.slice(at);
  const lower = rest.toLowerCase();
  for (const [spelling, unit] of UNIT_SPELLINGS) {
    const latin = LATIN_LETTER.test(spelling);
    if (!(latin ? lower : rest).startsWith(spelling)) continue;
    const end = at + spelling.length;
    if (latin && LATIN_LETTER.test(text[end] ?? '')) return null;
    return { unit, end };
  }
  return null;
}

/** 把已 NFKC 的文本切成「数值 + 单位」记号；阿拉伯数字按整段读，保证「124盒」不会读出「24盒」。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isAsciiDigit(ch)) {
      const match = /^\d+(?:\.\d+)?/.exec(text.slice(i));
      const raw = match?.[0] ?? ch ?? '';
      const numberEnd = i + raw.length;
      const unit = readUnit(text, numberEnd);
      tokens.push({
        value: canonicalDecimal(raw),
        unit: unit?.unit ?? null,
        start: i,
        end: unit?.end ?? numberEnd,
      });
      i = unit?.end ?? numberEnd;
      continue;
    }
    if (isCnNumeral(ch)) {
      let j = i;
      // 「千克」的「千」属于单位，不并进数字。
      while (j < text.length && isCnNumeral(text[j]) && !(text[j] === '千' && text[j + 1] === '克'))
        j += 1;
      const value = j > i ? parseCnNumber(text.slice(i, j)) : null;
      if (value === null) {
        i += 1;
        continue;
      }
      const unit = readUnit(text, j);
      tokens.push({
        value: String(value),
        unit: unit?.unit ?? null,
        start: i,
        end: unit?.end ?? j,
      });
      i = unit?.end ?? j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

/**
 * spec 的归一结果：NFKC、去空白、中文数字转阿拉伯数字、单位归一。
 * 没有可识别规格，或有数字没跟着清单内单位（如「24」「2公斤」）时返回 null——从严，
 * 不让部分可识别的 spec 被当成整体命中。
 */
export function normalizeSpec(text: string): NormalizedSpec | null {
  const tokens = tokenize(text.normalize('NFKC'));
  if (tokens.length === 0) return null;
  const specs: { value: string; unit: SpecUnit }[] = [];
  for (const token of tokens) {
    if (token.unit === null) return null;
    specs.push({ value: token.value, unit: token.unit });
  }
  return specs;
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
}

/** 返回标题 NFKC 后的匹配片段，去掉空白；所有规格均命中才返回。 */
export function findSpecInTitle(spec: string, title: string): string | null {
  const wanted = normalizeSpec(spec);
  if (wanted === null) return null;
  const nfkc = title.normalize('NFKC');
  const tokens = tokenize(nfkc).filter((token) => token.unit !== null);
  const chosen = new Set<Token>();
  for (const item of wanted) {
    const hit = tokens.find((token) => token.value === item.value && token.unit === item.unit);
    if (hit === undefined) return null;
    chosen.add(hit);
  }
  const spans = [...chosen].sort((a, b) => a.start - b.start);
  let fragment = '';
  let previousEnd: number | null = null;
  for (const span of spans) {
    if (previousEnd !== null) {
      // 相邻规格之间只有空白或符号（如「500ml×24瓶」）时保留原文；隔着别的字则用「、」分开，
      // 不把品类或其他标题文字带进片段。
      const gap = stripWhitespace(nfkc.slice(previousEnd, span.start));
      fragment += /[\p{L}\p{N}]/u.test(gap) ? '、' : gap;
    }
    fragment += stripWhitespace(nfkc.slice(span.start, span.end));
    previousEnd = span.end;
  }
  return fragment;
}

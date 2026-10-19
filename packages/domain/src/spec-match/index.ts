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
  /** 未识别单位，或数字写法不受支持（如「二点五十」）时为 null。 */
  readonly unit: SpecUnit | null;
  /** 在去空白文本中的起止位置（含数字与单位，左闭右开）。 */
  readonly start: number;
  readonly end: number;
}

/**
 * NFKC 并去掉全部空白后的文本。数字边界、中文数字、小数、单位都在这段连续文本上判断：
 * 「2 4盒」读作 24盒、「500毫 升」读作 500毫升，「124盒」「240盒」仍按整段数字读。
 */
interface Prepared {
  readonly text: string;
  /** gapBefore[k]：原文中去空白后第 k 个字之前紧挨着空白（只用于拉丁字母单位的词边界）。 */
  readonly gapBefore: readonly boolean[];
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

/** 小数点：阿拉伯「.」与中文「点」（「二点五」「2点5」）。 */
const DECIMAL_POINTS = new Set(['.', '点']);

const WHITESPACE = /\s/u;
const LATIN_LETTER = /[A-Za-z]/;

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isCnNumeral(ch: string | undefined): boolean {
  return ch !== undefined && (ch in CN_DIGITS || ch in CN_MULTIPLIERS || ch === '万');
}

/** 数字串里的一个字：阿拉伯数字或中文数字（「千克」的「千」属于单位，不算）。 */
function isNumeralAt(text: string, at: number): boolean {
  const ch = text[at];
  if (isAsciiDigit(ch)) return true;
  return isCnNumeral(ch) && !(ch === '千' && text[at + 1] === '克');
}

/** 小数部分的单个数位：0–9 或 零〇一二三四五六七八九（「两」「十」等不是数位）。 */
function fractionDigit(ch: string): string | null {
  if (isAsciiDigit(ch)) return ch;
  if (ch === '两') return null;
  const d = CN_DIGITS[ch];
  return d === undefined ? null : String(d);
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

function prepare(raw: string): Prepared {
  const nfkc = raw.normalize('NFKC');
  let text = '';
  const gapBefore: boolean[] = [];
  let pendingGap = false;
  for (let i = 0; i < nfkc.length; i += 1) {
    const ch = nfkc[i] ?? '';
    if (WHITESPACE.test(ch)) {
      pendingGap = true;
      continue;
    }
    text += ch;
    gapBefore.push(pendingGap);
    pendingGap = false;
  }
  return { text, gapBefore };
}

/**
 * 数字之后的单位；拉丁字母单位后面不能紧跟字母（「64GB」「64 GB」不是 64g），
 * 原文在单位之后有空白（「500g x2」）时算词边界。
 */
function readUnit(prepared: Prepared, at: number): { unit: SpecUnit; end: number } | null {
  const { text, gapBefore } = prepared;
  const rest = text.slice(at);
  const lower = rest.toLowerCase();
  for (const [spelling, unit] of UNIT_SPELLINGS) {
    const latin = LATIN_LETTER.test(spelling);
    if (!(latin ? lower : rest).startsWith(spelling)) continue;
    const end = at + spelling.length;
    if (latin && LATIN_LETTER.test(text[end] ?? '') && gapBefore[end] !== true) return null;
    return { unit, end };
  }
  return null;
}

/** 从 at 起连续的数字串（阿拉伯、中文混排）的结束位置。 */
function numeralRunEnd(text: string, at: number): number {
  let j = at;
  while (j < text.length && isNumeralAt(text, j)) j += 1;
  return j;
}

/** 从 at 起「小数点 + 数字串」反复出现部分的结束位置；用于整段吞掉不受支持的写法。 */
function decimalTailEnd(text: string, at: number): number {
  let j = at;
  while (DECIMAL_POINTS.has(text[j] ?? '') && isNumeralAt(text, j + 1)) {
    j = numeralRunEnd(text, j + 1);
  }
  return j;
}

/**
 * 整数部分之后的小数部分（「.5」「点五」）。返回 null 表示没有小数部分；
 * 返回 { digits: null } 表示有小数点和数字，但写法不受支持（如「二点五十」「2.5.1」）。
 */
function readFraction(text: string, at: number): { digits: string | null; end: number } | null {
  if (!DECIMAL_POINTS.has(text[at] ?? '') || !isNumeralAt(text, at + 1)) return null;
  const runEnd = numeralRunEnd(text, at + 1);
  let digits = '';
  for (let k = at + 1; k < runEnd; k += 1) {
    const d = fractionDigit(text[k] ?? '');
    if (d === null) return { digits: null, end: decimalTailEnd(text, at) };
    digits += d;
  }
  // 「2.5.1」「二点五点一」这类多个小数点的写法整体不受支持。
  if (DECIMAL_POINTS.has(text[runEnd] ?? '') && isNumeralAt(text, runEnd + 1)) {
    return { digits: null, end: decimalTailEnd(text, at) };
  }
  return { digits, end: runEnd };
}

/**
 * 把去空白文本切成「数值 + 单位」记号。阿拉伯数字按整段读，保证「124盒」不会读出「24盒」；
 * 小数按完整数值读（「二点五升」= 2.5 升），不从小数内部重新提取尾部数字。
 */
function tokenize(prepared: Prepared): Token[] {
  const { text } = prepared;
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let intEnd: number;
    let intValue: string;
    if (isAsciiDigit(ch)) {
      intEnd = i;
      while (isAsciiDigit(text[intEnd])) intEnd += 1;
      intValue = text.slice(i, intEnd);
    } else if (isCnNumeral(ch)) {
      intEnd = i;
      while (intEnd < text.length && isCnNumeral(text[intEnd]) && isNumeralAt(text, intEnd)) {
        intEnd += 1;
      }
      const parsed = intEnd > i ? parseCnNumber(text.slice(i, intEnd)) : null;
      if (parsed === null) {
        // 结构不合法的中文数字串（多为品牌、品名用字，如「统一」后接「二十四」）从下一个字再试。
        i += 1;
        continue;
      }
      intValue = String(parsed);
    } else {
      i += 1;
      continue;
    }

    let numberEnd = intEnd;
    let value: string | null = canonicalDecimal(intValue);
    const fraction = readFraction(text, intEnd);
    if (fraction !== null) {
      numberEnd = fraction.end;
      value = fraction.digits === null ? null : canonicalDecimal(`${intValue}.${fraction.digits}`);
    }

    if (value === null) {
      // 不受支持的数字写法：整段记为无单位，单位也一并吞掉，不让尾部被读成别的规格。
      const unit = readUnit(prepared, numberEnd);
      const end = unit?.end ?? numberEnd;
      tokens.push({ value: '', unit: null, start: i, end });
      i = end;
      continue;
    }

    const unit = readUnit(prepared, numberEnd);
    tokens.push({ value, unit: unit?.unit ?? null, start: i, end: unit?.end ?? numberEnd });
    i = unit?.end ?? numberEnd;
  }
  return tokens;
}

/**
 * spec 的归一结果：NFKC、去空白、中文数字转阿拉伯数字、单位归一。
 * 没有可识别规格，或有数字没跟着清单内单位（如「24」「2公斤」）时返回 null——从严，
 * 不让部分可识别的 spec 被当成整体命中。
 */
export function normalizeSpec(text: string): NormalizedSpec | null {
  const tokens = tokenize(prepare(text));
  if (tokens.length === 0) return null;
  const specs: { value: string; unit: SpecUnit }[] = [];
  for (const token of tokens) {
    if (token.unit === null) return null;
    specs.push({ value: token.value, unit: token.unit });
  }
  return specs;
}

/** 返回标题 NFKC、去空白后的匹配片段；所有规格均命中才返回。 */
export function findSpecInTitle(spec: string, title: string): string | null {
  const wanted = normalizeSpec(spec);
  if (wanted === null) return null;
  const prepared = prepare(title);
  const { text } = prepared;
  const tokens = tokenize(prepared).filter((token) => token.unit !== null);
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
      // 相邻规格之间只有符号（如「500ml×24瓶」）时保留原文；隔着别的字则用「、」分开，
      // 不把品类或其他标题文字带进片段。
      const gap = text.slice(previousEnd, span.start);
      fragment += /[\p{L}\p{N}]/u.test(gap) ? '、' : gap;
    }
    fragment += text.slice(span.start, span.end);
    previousEnd = span.end;
  }
  return fragment;
}

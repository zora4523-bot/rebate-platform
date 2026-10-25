// B1-12z · Save checks of an SMS registration's preview text (CT-24t adminRegisterNotifySms; 08
// BR-TEXT-20 细则「短信渠道登记与后台渠道开关」 保存校验, BR-TEXT-20 rule row, BR-ID-05; orchestrator
// ruling D10-335 ②). In the contract's order, the first failing check is the answer:
//   1. the placeholders `${name}` (as in the provider's template) are exactly the variables the
//      code defines for the variant → else reason notify_preview_vars_mismatch;
//   2. SMS_CODE only: every 分钟 in the text follows a number N (Arabic, full-width or Chinese
//      numerals such as 五, 十, 十五, 两) with N × 60 equal to the code validity of BR-ID-05; a
//      分钟 without a number it can read also fails (a text without 分钟 passes) → else reason
//      notify_code_ttl_mismatch;
//   3. BR-TEXT-20 and BR-TEXT-13: the first sentence does not start with a platform name (a
//      leading 【…】 is taken off first only when it holds exactly the registration's signature;
//      any other bracket stays and is checked), no 「官方」 anywhere, no forbidden word → else
//      the words found, after the field (platform name, then 官方, then the forbidden words in
//      list order).
//
// Pure module (no decorators, erasable syntax).

export type PreviewProblem =
  | { readonly reason: 'notify_preview_vars_mismatch' }
  | { readonly reason: 'notify_code_ttl_mismatch' }
  | { readonly words: readonly string[] };

export interface PreviewCheck {
  readonly text: string;
  readonly variables: readonly string[];
  /** The registration's signature (sign_name, without 【】). */
  readonly signName: string;
  /** BR-ID-05 code validity in seconds; set for SMS_CODE only. */
  readonly codeTtlSec: number | null;
  /** BR-TEXT-13 forbidden words found in the text (content's list), in list order. */
  readonly bannedWords: (text: string) => readonly string[];
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;
/** Every 分钟, with the number written before it when there is one. */
const MINUTES = /([0-9０-９]+|[零〇一二两三四五六七八九十百]+)?\s*分钟/g;
const CHINESE_DIGITS: Readonly<Record<string, number>> = {
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
/** BR-TEXT-20 rule row: 首句不得以平台名称开头. */
const LEADING_PLATFORM = /^[【[]?(淘宝|天猫|京东|拼多多|美团|阿里|支付宝)/;
/** A leading 【…】 (the provider prepends the signature so; the operator may copy it). */
const SIGNATURE = /^\s*【([^】]*)】/;
const OFFICIAL = '官方';

function placeholders(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] ?? '');
  return names;
}

function sameSet(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  const wanted = new Set(expected);
  if (actual.size !== wanted.size) return false;
  for (const name of actual) if (!wanted.has(name)) return false;
  return true;
}

function halfWidth(digits: string): string {
  return digits.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
}

/** A Chinese numeral (一 … 九, 两, 十, 百, 零 / 〇 as a gap), or null when it does not read. */
export function chineseNumber(text: string): number | null {
  let total = 0;
  let digit: number | null = null;
  for (const char of text) {
    if (char === '零' || char === '〇') {
      digit = null;
    } else if (char === '十' || char === '百') {
      total += (digit ?? 1) * (char === '十' ? 10 : 100);
      digit = null;
    } else {
      const value = CHINESE_DIGITS[char];
      if (value === undefined || digit !== null) return null;
      digit = value;
    }
  }
  return total + (digit ?? 0);
}

/** The number before each 分钟 of the text, in minutes; null where none can be read. */
export function statedMinutes(text: string): (number | null)[] {
  return [...text.matchAll(MINUTES)].map((match) => {
    const written = match[1];
    if (written === undefined) return null;
    if (/^[0-9０-９]+$/.test(written)) return Number(halfWidth(written));
    return chineseNumber(written);
  });
}

/** The words of check 3, empty when the text passes. */
export function channelWords(
  text: string,
  signName: string,
  bannedWords: (text: string) => readonly string[],
): string[] {
  const words: string[] = [];
  const signature = SIGNATURE.exec(text);
  const body =
    signature !== null && signature[1] === signName
      ? text.slice(signature[0].length).trimStart()
      : text.trimStart();
  const leading = LEADING_PLATFORM.exec(body);
  if (leading !== null && leading[1] !== undefined) words.push(leading[1]);
  if (text.includes(OFFICIAL)) words.push(OFFICIAL);
  for (const word of bannedWords(text)) if (!words.includes(word)) words.push(word);
  return words;
}

/** The first failing check, or undefined when the preview text may be saved. */
export function previewProblem(check: PreviewCheck): PreviewProblem | undefined {
  if (!sameSet(placeholders(check.text), check.variables)) {
    return { reason: 'notify_preview_vars_mismatch' };
  }
  const ttl = check.codeTtlSec;
  const wrong = (minutes: number | null): boolean => minutes === null || minutes * 60 !== ttl;
  if (ttl !== null && statedMinutes(check.text).some(wrong)) {
    return { reason: 'notify_code_ttl_mismatch' };
  }
  const words = channelWords(check.text, check.signName, check.bannedWords);
  return words.length === 0 ? undefined : { words };
}

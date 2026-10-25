// B1-12z · Save checks of an SMS registration's preview text (CT-24t adminRegisterNotifySms; 08
// BR-TEXT-20 细则「短信渠道登记与后台渠道开关」 保存校验, BR-TEXT-20 rule row, BR-ID-05; orchestrator
// ruling D10-335 ②). In the contract's order, the first failing check is the answer:
//   1. the placeholders `${name}` (as in the provider's template) are exactly the variables the
//      code defines for the variant → else reason notify_preview_vars_mismatch;
//   2. SMS_CODE only: every validity written as N分钟 has N × 60 equal to the code validity of
//      BR-ID-05 (a text that states none passes) → else reason notify_code_ttl_mismatch;
//   3. BR-TEXT-20 and BR-TEXT-13: the first sentence after the signature does not start with a
//      platform name, no 「官方」 anywhere, no forbidden word → else the words found, after the
//      field (platform name, then 官方, then the forbidden words in list order).
//
// Pure module (no decorators, erasable syntax).

export type PreviewProblem =
  | { readonly reason: 'notify_preview_vars_mismatch' }
  | { readonly reason: 'notify_code_ttl_mismatch' }
  | { readonly words: readonly string[] };

export interface PreviewCheck {
  readonly text: string;
  readonly variables: readonly string[];
  /** BR-ID-05 code validity in seconds; set for SMS_CODE only. */
  readonly codeTtlSec: number | null;
  /** BR-TEXT-13 forbidden words found in the text (content's list), in list order. */
  readonly bannedWords: (text: string) => readonly string[];
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const MINUTES = /([0-9０-９]+)\s*分钟/g;
/** BR-TEXT-20 rule row: 首句不得以平台名称开头. */
const LEADING_PLATFORM = /^[【[]?(淘宝|天猫|京东|拼多多|美团|阿里|支付宝)/;
/** The signature the provider prepends, 【…】, when the operator copied it into the preview. */
const SIGNATURE = /^\s*【[^】]*】/;
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

/** Validities written in the text, in minutes. */
function statedMinutes(text: string): number[] {
  return [...text.matchAll(MINUTES)].map((match) => Number(halfWidth(match[1] ?? '')));
}

/** The words of check 3, empty when the text passes. */
export function channelWords(
  text: string,
  bannedWords: (text: string) => readonly string[],
): string[] {
  const words: string[] = [];
  const body = text.replace(SIGNATURE, '').trimStart();
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
  if (ttl !== null && statedMinutes(check.text).some((minutes) => minutes * 60 !== ttl)) {
    return { reason: 'notify_code_ttl_mismatch' };
  }
  const words = channelWords(check.text, check.bannedWords);
  return words.length === 0 ? undefined : { words };
}

export type TextScope = 'user_visible' | 'admin_report';

export interface BannedWord {
  readonly word: string;
  readonly category: string;
  readonly scopes: readonly TextScope[];
  readonly allow_keys?: readonly string[];
  readonly allow_rendered_in?: readonly string[];
  readonly allow_articles?: readonly {
    readonly config_key: string;
    readonly fields: readonly string[];
  }[];
}

export interface TextGuardInput {
  readonly fragments: readonly { readonly text: string; readonly key?: string }[];
  readonly template_code?: string;
  readonly article_config_keys?: readonly string[];
  readonly article_field?: string;
}

export interface TextKeySegment {
  readonly prefixes: readonly string[];
  readonly keys: readonly string[];
  readonly notify_templates: readonly string[];
}

export interface FundTermKeys {
  readonly fund_terms: TextKeySegment;
  readonly ordinary: TextKeySegment;
  readonly exempt: readonly { readonly key: string; readonly reason: string }[];
}

export type TextKeyClass = 'fund_terms' | 'agreement' | 'general';

export type TextVariablesResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown_key' }
  | {
      readonly ok: false;
      readonly reason: 'variables_mismatch';
      readonly missing: readonly string[];
      readonly extra: readonly string[];
    };

// 规划/08 BR-TEXT-13 细则「归一化」第 ② 步与第 ③ 步要剔除的字符。
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const STRIPPED_CATEGORIES = /[\p{Z}\p{P}\p{S}\p{Mn}\p{Mc}\p{Me}\p{Cf}\p{Cc}]/gu;
const ASCII_UPPER = /[A-Z]/g;
// 规划/08 BR-TEXT-12：模板变量写作 `{name}`。
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const AGREEMENT_PREFIXES = ['privacy.', 'perm.'] as const;

/**
 * BR-TEXT-13 的匹配用归一化：① NFKC ② 去 Default_Ignorable_Code_Point ③ 去类别 Z、P、S、Mn、Mc、
 * Me、Cf、Cc ④ 只把英文字母 A–Z 转小写。只用于匹配，展示与存储的原文不变。
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DEFAULT_IGNORABLE, '')
    .replace(STRIPPED_CATEGORIES, '')
    .replace(ASCII_UPPER, (c) => c.toLowerCase());
}

/** 字典键与 allow_keys 模式按原文逐段比较；`*` 恰好通配一个非空段。 */
function keyMatches(pattern: string, key: string): boolean {
  const patternSegments = pattern.split('.');
  const keySegments = key.split('.');
  if (patternSegments.length !== keySegments.length) return false;
  return patternSegments.every((segment, i) => {
    const actual = keySegments[i] ?? '';
    return segment === '*' ? actual.length > 0 : segment === actual;
  });
}

function fragmentAllowed(
  fragment: { readonly key?: string },
  word: BannedWord,
  templateCode: string | undefined,
): boolean {
  const key = fragment.key;
  if (key === undefined) return false;
  if (!(word.allow_keys ?? []).some((pattern) => keyMatches(pattern, key))) return false;
  return templateCode === undefined || (word.allow_rendered_in ?? []).includes(templateCode);
}

function articleAllowed(input: TextGuardInput, word: BannedWord): boolean {
  const configKeys = input.article_config_keys;
  const field = input.article_field;
  if (configKeys === undefined || field === undefined) return false;
  return (word.allow_articles ?? []).some(
    (rule) => configKeys.includes(rule.config_key) && rule.fields.includes(field),
  );
}

/**
 * BR-TEXT-13 禁用词匹配：先按字段位置剔除白名单片段（原文匹配），剩余片段各自归一化后与归一化的词做
 * 子串匹配（片段之间不拼接）。只查 scopes 含 scope 的词；结果按 words 顺序去重、保留词表原词。
 */
export function findBannedWords(
  input: TextGuardInput,
  words: readonly BannedWord[],
  scope: TextScope,
): string[] {
  const normalizedFragments = input.fragments.map((fragment) => normalizeForMatch(fragment.text));
  const hits: string[] = [];
  for (const word of words) {
    if (!word.scopes.includes(scope) || hits.includes(word.word)) continue;
    const needle = normalizeForMatch(word.word);
    if (needle.length === 0 || articleAllowed(input, word)) continue;
    const hit = input.fragments.some(
      (fragment, i) =>
        !fragmentAllowed(fragment, word, input.template_code) &&
        (normalizedFragments[i] ?? '').includes(needle),
    );
    if (hit) hits.push(word.word);
  }
  return hits;
}

function segmentCovers(segment: TextKeySegment, key: string): boolean {
  return segment.keys.includes(key) || segment.prefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * 文案键分类（specs/fund-term-keys.yaml，BR-TEXT-12 / BR-TEXT-14）：只落 ordinary 的键才不是资金术语；
 * 其中 `privacy.` / `perm.` 开头的归协议类。两段都落或都不落按资金术语处理。
 */
export function classifyTextKey(key: string, fundTermKeys: FundTermKeys): TextKeyClass {
  const inFund = segmentCovers(fundTermKeys.fund_terms, key);
  const inOrdinary = segmentCovers(fundTermKeys.ordinary, key);
  if (inFund || !inOrdinary) return 'fund_terms';
  return AGREEMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) ? 'agreement' : 'general';
}

/** 通知模板编码按整值查 notify_templates；只落 ordinary 才是普通，其余按资金术语处理。 */
export function classifyTemplate(
  code: string,
  fundTermKeys: FundTermKeys,
): 'fund_terms' | 'general' {
  const inFund = fundTermKeys.fund_terms.notify_templates.includes(code);
  const inOrdinary = fundTermKeys.ordinary.notify_templates.includes(code);
  return !inFund && inOrdinary ? 'general' : 'fund_terms';
}

function placeholderNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 后台保存 texts 时的变量校验：模板变量集合必须与包内默认文案一致（只比集合，不比次数与顺序）；
 * 去掉合法占位后仍有花括号也拒绝。键不在默认文案里返回 unknown_key。
 */
export function checkTextVariables(
  key: string,
  text: string,
  defaults: Readonly<Record<string, string>>,
): TextVariablesResult {
  if (!Object.hasOwn(defaults, key)) return { ok: false, reason: 'unknown_key' };
  const defaultText = defaults[key];
  if (typeof defaultText !== 'string') return { ok: false, reason: 'unknown_key' };
  const expected = placeholderNames(defaultText);
  const actual = placeholderNames(text);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  const strayBrace = /[{}]/.test(text.replace(PLACEHOLDER, ''));
  if (missing.length === 0 && extra.length === 0 && !strayBrace) return { ok: true };
  return { ok: false, reason: 'variables_mismatch', missing, extra };
}

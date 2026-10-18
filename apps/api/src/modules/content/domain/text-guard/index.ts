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

export function normalizeForMatch(text: string): string {
  void text;
  throw new Error('NotImplemented: normalizeForMatch');
}

export function findBannedWords(
  input: TextGuardInput,
  words: readonly BannedWord[],
  scope: TextScope,
): string[] {
  void input;
  void words;
  void scope;
  throw new Error('NotImplemented: findBannedWords');
}

export function classifyTextKey(key: string, fundTermKeys: FundTermKeys): TextKeyClass {
  void key;
  void fundTermKeys;
  throw new Error('NotImplemented: classifyTextKey');
}

export function classifyTemplate(
  code: string,
  fundTermKeys: FundTermKeys,
): 'fund_terms' | 'general' {
  void code;
  void fundTermKeys;
  throw new Error('NotImplemented: classifyTemplate');
}

export function checkTextVariables(
  key: string,
  text: string,
  defaults: Readonly<Record<string, string>>,
): TextVariablesResult {
  void key;
  void text;
  void defaults;
  throw new Error('NotImplemented: checkTextVariables');
}

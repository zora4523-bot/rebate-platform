// The text dictionary of BR-TEXT-12, shared by its read and write sides.
// - F1-02s (GET /v1/dict): splitDictKey, parseDictVersion (read-side version + row limit),
//   CurrentDictRow and dictItems.
// - F1-02t (admin dictionary editor; 规划/08 BR-TEXT-12 细则「写入口统一」与「权限」, BR-TEXT-13;
//   04 §11.2 config.general / content.fund_terms / content.agreement; contract operations
//   adminSaveDictItems / adminRollbackDictItems): permissions, request class, joinDictKey,
//   parseWritableDictVersion, text checks and checkDictSave / checkDictRollback.
// Pure module: no I/O, no clock, no Nest, no decorators (erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import {
  checkTextVariables,
  classifyTextKey,
  findBannedWords,
  type BannedWord,
  type FundTermKeys,
  type TextKeyClass,
  type TextScope,
} from '../text-guard/index.ts';

type DictItems = Schema<'Dict'>['items'];

/** Largest dict_items.version a published dictionary can name (column type integer). */
const INT32_MAX = 2_147_483_647;
const CANONICAL_POSITIVE = /^[1-9][0-9]{0,9}$/;

/** The first dot separates the dictionary name from the complete, possibly empty code. */
export function splitDictKey(key: string): { dict: string; code: string } {
  const dot = key.indexOf('.');
  return dot < 0 ? { dict: key, code: '' } : { dict: key.slice(0, dot), code: key.slice(dot + 1) };
}

/**
 * Preserve string config values; missing/non-string values use the config sentinel "0".
 * Only canonical decimal positive int32 strings have a readable dictionary version.
 */
export function parseDictVersion(value: unknown): { version: string; limit: number | null } {
  // Same judgement as /v1/config's optional('dict_version', isString, '0').
  if (typeof value !== 'string') return { version: '0', limit: null };
  if (!CANONICAL_POSITIVE.test(value)) return { version: value, limit: null };
  const limit = Number(value);
  return { version: value, limit: limit <= INT32_MAX ? limit : null };
}

/** One current dict_items row: the highest version ≤ the published dict_version of its key. */
export interface CurrentDictRow {
  readonly dict: string;
  readonly code: string;
  /** null: set back to the bundled default, so the key is left out. */
  readonly text: string | null;
}

/**
 * `items[dict][code] = text` for every current row whose text is not null. Assignment goes
 * through defineProperty so a code such as `__proto__` stays an ordinary key.
 */
export function dictItems(rows: readonly CurrentDictRow[]): DictItems {
  const items: DictItems = {};
  for (const row of rows) {
    if (row.text === null) continue;
    let entries = Object.hasOwn(items, row.dict) ? items[row.dict] : undefined;
    if (entries === undefined) {
      entries = {};
      define(items, row.dict, entries);
    }
    define(entries, row.code, row.text);
  }
  return items;
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export type DictPermission = 'config.general' | 'content.fund_terms' | 'content.agreement';

/** Reads accept any one of the three points (contract adminListDictItems). */
export const DICT_READ_PERMISSIONS: readonly DictPermission[] = [
  'config.general',
  'content.fund_terms',
  'content.agreement',
];

const PERMISSION_OF: Readonly<Record<TextKeyClass, DictPermission>> = {
  general: 'config.general',
  fund_terms: 'content.fund_terms',
  agreement: 'content.agreement',
};

/** The one permission point that writes keys of this class (L12 / L38). */
export function dictPermissionOf(keyClass: TextKeyClass): DictPermission {
  return PERMISSION_OF[keyClass];
}

/**
 * The single class of a write request, or null when the request names no key or keys of more
 * than one class. Keys the specification cannot place count as fund terms (classifyTextKey).
 */
export function dictRequestClass(
  keys: readonly string[],
  fundTermKeys: FundTermKeys,
): TextKeyClass | null {
  const classes = new Set(keys.map((key) => classifyTextKey(key, fundTermKeys)));
  if (classes.size !== 1) return null;
  return classes.values().next().value ?? null;
}

/** Inverse of splitDictKey: `a` + `b.c` → `a.b.c`, an empty code gives the bare dictionary name. */
export function joinDictKey(dict: string, code: string): string {
  return code.length === 0 ? dict : `${dict}.${code}`;
}

/** Highest dictionary version that still leaves room for the next one in an int32 column. */
const MAX_DICT_VERSION = 2 ** 31 - 2;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Write side (F1-02t): dict_version as stored (a JSON string of a decimal integer, "0" before
 * the first publish). Anything else — a non-decimal string, a leading zero, a number, an out-of-range value — is null:
 * writes refuse it (50001, L47), reads show no override.
 */
export function parseWritableDictVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version <= MAX_DICT_VERSION ? version : null;
}

/**
 * The banned-word scope of a dictionary key (BR-TEXT-13: user_visible = texts users see,
 * admin_report = console and report fields). Every key of contracts/texts.default.json is shown to
 * users by the clients, so all dictionary keys check the user_visible list; the scope stays a
 * parameter of the check so a console-only key family can be routed to admin_report here.
 */
export function dictTextScope(key: string): TextScope {
  void key;
  return 'user_visible';
}

export interface DictTextRules {
  readonly defaults: Readonly<Record<string, string>>;
  readonly words: readonly BannedWord[];
  readonly scopeOf?: (key: string) => TextScope;
}

/** null when the text passes; otherwise the forbidden words found (possibly none, for variables). */
export function dictTextProblems(
  key: string,
  text: string,
  rules: DictTextRules,
): readonly string[] | null {
  const variables = checkTextVariables(key, text, rules.defaults);
  const words = findBannedWords(
    { fragments: [{ text, key }] },
    rules.words,
    (rules.scopeOf ?? dictTextScope)(key),
  );
  return variables.ok && words.length === 0 ? null : words;
}

export interface DictSaveCheck {
  readonly changes: readonly { readonly key: string; readonly text: string | null }[];
  readonly keyClass: TextKeyClass;
  readonly legalConfirmedBy: string | null;
  /** The key's effective override at the current dictionary version (null = bundled default). */
  readonly current: (key: string) => string | null;
  readonly rules: DictTextRules;
}

/**
 * Every problem of a save, in request order (contract adminSaveDictItems): an unknown, repeated
 * or unchanged key → `changes[i].key`; a text failing the variable or forbidden-word check →
 * `changes[i].text` followed by the words found; an agreement save without a legal confirmer →
 * `legal_confirmed_by`. Empty = valid.
 */
export function checkDictSave(input: DictSaveCheck): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  input.changes.forEach((change, i) => {
    const known = Object.hasOwn(input.rules.defaults, change.key);
    const repeated = seen.has(change.key);
    seen.add(change.key);
    if (!known || repeated || input.current(change.key) === change.text) {
      fields.push(`changes[${String(i)}].key`);
      return;
    }
    if (change.text === null) return;
    const problems = dictTextProblems(change.key, change.text, input.rules);
    if (problems !== null) fields.push(`changes[${String(i)}].text`, ...problems);
  });
  if (input.keyClass === 'agreement' && input.legalConfirmedBy === null) {
    fields.push('legal_confirmed_by');
  }
  return fields;
}

export interface DictRollbackCheck {
  readonly keys: readonly string[];
  readonly toVersion: number;
  readonly currentVersion: number;
  readonly keyClass: TextKeyClass;
  readonly legalConfirmedBy: string | null;
  /** The key's newest text at or below to_version (null = none, or to_version 0). */
  readonly restored: (key: string) => string | null;
  readonly rules: DictTextRules;
}

/**
 * Every problem of a rollback (contract adminRollbackDictItems): `to_version` not lower than the
 * current version; an unknown or repeated key → `keys[i]`; a restored text failing the variable
 * or forbidden-word check → `keys[i]` followed by the words found (restored texts are not checked
 * when to_version itself is invalid); an agreement rollback without a legal confirmer.
 */
export function checkDictRollback(input: DictRollbackCheck): string[] {
  const fields: string[] = [];
  const targetValid = input.toVersion < input.currentVersion;
  if (!targetValid) fields.push('to_version');
  const seen = new Set<string>();
  input.keys.forEach((key, i) => {
    const known = Object.hasOwn(input.rules.defaults, key);
    const repeated = seen.has(key);
    seen.add(key);
    if (!known || repeated) {
      fields.push(`keys[${String(i)}]`);
      return;
    }
    if (!targetValid) return;
    const text = input.restored(key);
    if (text === null) return;
    const problems = dictTextProblems(key, text, input.rules);
    if (problems !== null) fields.push(`keys[${String(i)}]`, ...problems);
  });
  if (input.keyClass === 'agreement' && input.legalConfirmedBy === null) {
    fields.push('legal_confirmed_by');
  }
  return fields;
}

// The text dictionary of BR-TEXT-12 (F1-02s GET /v1/dict; F1-02t's admin publisher reuses it).
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';

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

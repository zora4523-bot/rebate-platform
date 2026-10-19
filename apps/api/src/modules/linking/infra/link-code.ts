// B1-08s (BR-ATTR-15 lk 细则): the link short code. Issued on its own — six characters of base36
// [0-9a-z], each drawn with crypto.randomInt — never derived from link_id, attr_code, the user or
// the time; a failing random source throws (no fallback). links.lk accepts 1–16 characters
// (CHECK links_lk_check), so the issued length can grow later without touching the column.
import { randomInt } from 'node:crypto';
import type { DB } from '@couli/db';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Issued length (BR-ATTR-15 default: 6; 36⁶ ≈ 2.18 × 10⁹). */
export const LINK_CODE_LENGTH = 6;

/** A stored or parsed lk: 1–16 lowercase base36 characters (links_lk_check, BR-ATTR-06). */
export const LINK_CODE = /^[0-9a-z]{1,16}$/;

/** BR-ATTR-15: independent, six-character base36 random code; production uses crypto.randomInt. */
export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) code += ALPHABET.charAt(randomInt(0, 36));
  return code;
}

/**
 * The links table with lk, until db.gen.ts is regenerated from migration 0050 (pnpm db:snapshot,
 * outside_needed); identical to DB once it carries the column.
 */
export type LinkCodeDB = Omit<DB, 'links'> & {
  links: DB['links'] & { lk: string | null };
};

/**
 * links.lk as stored on a row read with selectAll (null when absent, NULL or not a valid code).
 * Read structurally so it serves before and after db.gen.ts carries the column (outside_needed:
 * pnpm db:snapshot regenerates the types from migration 0050).
 */
export function storedLinkCode(link: object): string | null {
  const value: unknown = (link as { readonly lk?: unknown }).lk;
  return typeof value === 'string' && LINK_CODE.test(value) ? value : null;
}

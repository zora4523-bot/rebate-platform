// B2-08b (编排裁定 D10-181 ①, D10-459; 规划/08 BR-WDR-20, BR-ID-25 细则「实名更正」): identity's
// read-only port of the member's current real-name identity key, for payout's tax_ytd (the year's
// running totals are kept per identity, so a corrected real name starts a row of its own).
// readIdentityKey(executor, { appId, userId }) → the id_no_hmac of the member's app.realname row
// when its status is 'verified', else null (no row, 'none' — even with the hmac retained for tax —
// or 'failed'). One SELECT on the executor the caller passes (its uncommitted writes are visible);
// no locks, no writes, no logging; never the name or the id number, only the HMAC.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface RealnameIdentityKeyInput {
  readonly appId: string;
  readonly userId: string;
}

export interface RealnameIdentityKeyReader {
  /** The verified real name's id_no_hmac (64 lowercase hex), or null when there is none. */
  readIdentityKey(
    executor: Transaction<DB> | Kysely<DB>,
    input: RealnameIdentityKeyInput,
  ): Promise<string | null>;
}

export function createRealnameIdentityKeyReader(): RealnameIdentityKeyReader {
  throw new Error('NotImplemented: createRealnameIdentityKeyReader');
}

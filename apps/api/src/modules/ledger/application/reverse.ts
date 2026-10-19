import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { Ledger as PostingLedger, PostingResult } from './ledger.ts';

export interface ReverseInput {
  readonly appId: string;
  readonly originalUniqKey: string;
}

export interface Ledger extends PostingLedger {
  /** Whole-voucher reversal in the caller's transaction, with its balance locks already held.
   * Preserve structured metadata; the :REVERSE key identifies the correction.
   * Refuse missing originals with ORIGINAL_NOT_FOUND and reversal keys with
   * CANNOT_REVERSE_REVERSAL. Replay returns the stored reversal's PostingResult.
   */
  reverse(trx: Transaction<DB>, input: ReverseInput): Promise<PostingResult>;
}

/** Test-phase factory shell. Implementation composes the existing posting service here.
 * Keeping that factory unchanged preserves B2-02f while obeying the skeleton-only gate.
 */
export function createLedger(input: { readonly clock: Clock }): Ledger {
  void input;
  throw new Error('NotImplemented: createLedger.reverse');
}

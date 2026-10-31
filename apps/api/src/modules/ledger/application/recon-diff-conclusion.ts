// B2-04zd (D10-443): the read-only port of recon diff conclusions for the monthly bill
// (BR-FUND-04 ④: an order whose diff was concluded 「以联盟为准」 counts as matching).
//
// Only the structured conclusion counts (编排裁定 D10-447 ②, B2-09h): resolution.outcome = 'union',
// written by the console close (closeAdminReconDiff) on a settle_amount_mismatch diff of source R1.
// A closed status alone, `ours`, no outcome and the free-text reason are not it (job.ts:
// unionAuthoritative is not faked).
//
// D10-506: a conclusion is bound to the amounts of its diff, so the answer carries them and the
// bill compares them with the current ones. Diffs of the same amounts are one state: the last one
// closed with an outcome speaks (closed_at, id descending, across bills); a later `ours` takes the
// state away. A diff of an order has ref_id {order_key} or {order_key}#AMT#{base}:{b_settle}.
// Reads on the given handle only; never locks or writes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { selectUnionConclusions } from '../infra/recon-diffs-store.ts';

export interface UnionAuthoritativeSelection {
  readonly appId: string;
  /** order_key values (recon_diffs ref_type = 'order', see the header for ref_id). */
  readonly orderKeys: readonly string[];
}

/** The amounts of a diff concluded 「以联盟为准」: its expected_fen and actual_fen. */
export interface UnionConcludedAmounts {
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
}

/** Of `orderKeys`, those with a standing 「以联盟为准」 conclusion, each with the amounts it holds on. */
export async function readUnionAuthoritativeOrderKeys(
  db: Kysely<DB>,
  selection: UnionAuthoritativeSelection,
): Promise<ReadonlyMap<string, readonly UnionConcludedAmounts[]>> {
  const conclusions = new Map<string, UnionConcludedAmounts[]>();
  for (const row of await selectUnionConclusions(db, selection)) {
    const amounts = { expectedFen: row.expected_fen, actualFen: row.actual_fen };
    const known = conclusions.get(row.order_key);
    if (known === undefined) conclusions.set(row.order_key, [amounts]);
    else known.push(amounts);
  }
  return conclusions;
}

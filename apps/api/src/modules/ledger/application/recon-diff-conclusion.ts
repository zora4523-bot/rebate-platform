// B2-04zd (D10-443): the read-only port of recon diff conclusions for the monthly bill
// (BR-FUND-04 ④: an order whose diff was concluded 「以联盟为准」 counts as matching).
//
// Only the structured conclusion counts (编排裁定 D10-447 ②, B2-09h): resolution.outcome = 'union',
// written by the console close (closeAdminReconDiff) on an R1 diff. A closed status alone, `ours`,
// no outcome and the free-text reason are not it (job.ts: unionAuthoritative is not faked).
// Reads on the given handle only; never locks or writes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { selectUnionConcludedOrderKeys } from '../infra/recon-diffs-store.ts';

export interface UnionAuthoritativeSelection {
  readonly appId: string;
  /** order_key values (recon_diffs ref_type = 'order', ref_id = order_key). */
  readonly orderKeys: readonly string[];
}

/** The subset of `orderKeys` whose R1 diff is closed with the conclusion 「以联盟为准」. */
export async function readUnionAuthoritativeOrderKeys(
  db: Kysely<DB>,
  selection: UnionAuthoritativeSelection,
): Promise<ReadonlySet<string>> {
  return new Set(await selectUnionConcludedOrderKeys(db, selection));
}

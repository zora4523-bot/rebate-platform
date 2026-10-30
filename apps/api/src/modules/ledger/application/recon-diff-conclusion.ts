// B2-04zd (D10-443): the read-only port of recon diff conclusions for the monthly bill
// (BR-FUND-04 ④: an order whose diff was concluded 「以联盟为准」 counts as matching).
//
// Only a conclusion recorded in recon_diffs.resolution counts; a closed status alone is not the
// conclusion (job.ts: unionAuthoritative is not faked from the closed status). The current writers
// of resolution (registration, the console close that only records `reason`) have no recognisable
// 「以联盟为准」 conclusion, so no order key is returned until one is ruled (待编排裁定).
// Reads on the given handle only; never locks or writes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface UnionAuthoritativeSelection {
  readonly appId: string;
  /** order_key values (recon_diffs ref_type = 'order', ref_id = order_key). */
  readonly orderKeys: readonly string[];
}

/** The subset of `orderKeys` whose R1 diff is closed with the conclusion 「以联盟为准」. */
export function readUnionAuthoritativeOrderKeys(
  db: Kysely<DB>,
  selection: UnionAuthoritativeSelection,
): Promise<ReadonlySet<string>> {
  void db;
  void selection;
  throw new Error('NotImplemented: readUnionAuthoritativeOrderKeys');
}

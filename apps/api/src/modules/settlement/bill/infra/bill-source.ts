// B2-04zd (D10-443): the production readSource of the bill job (BR-FUND-04 ③ ④).
// Read only, on the job's transaction: the app / platform's orders with every order_settlements row,
// plus settlement rows without an order (order = null). Scope, cut-off and the greatest seq stay
// with the bill job; nothing the job has to judge is filtered out here.
// unionAuthoritative comes only from ledger's recon diff conclusion port (never from a closed status).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { BillJobDependencies } from '../job.ts';

/** Structurally ledger's readUnionAuthoritativeOrderKeys. */
export interface BillSourceDependencies {
  readUnionAuthoritative(
    db: Kysely<DB>,
    selection: { readonly appId: string; readonly orderKeys: readonly string[] },
  ): Promise<ReadonlySet<string>>;
}

export function createBillSourceReader(
  dependencies: BillSourceDependencies,
): BillJobDependencies['readSource'] {
  void dependencies;
  throw new Error('NotImplemented: createBillSourceReader');
}

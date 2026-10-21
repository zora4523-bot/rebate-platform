// Identity's port for "does this user have a withdrawal in flight" (task B1-15d §9.2 #2;
// BR-ID-27, BR-ID-31; orchestrator ruling D10-97). POST /v1/me/deletion asks it inside the claim's
// transaction, after locking the user's row, and answers 30412 when it says true.
//
// true = the user has a withdrawal in PENDING_REVIEW, APPROVED or PAYING, NOT counting one that
// was frozen by hand because of a ban (BR-ID-31: those are settled by finance during cooling).
// The status rule belongs to the implementation of this port (the payout module); identity never
// reads or judges withdrawal states itself. Reads on the caller's transaction (`trx`), no writes,
// no logging.
//
// Until the payout module exists (B2-05), app.module injects an implementation that truthfully
// answers false (TODO blocked on B2-05 there).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface WithdrawalInFlightInput {
  readonly appId: string;
  readonly userId: string;
}

export interface WithdrawalInFlightReader {
  hasInFlight(trx: Transaction<DB>, input: WithdrawalInFlightInput): Promise<boolean>;
}

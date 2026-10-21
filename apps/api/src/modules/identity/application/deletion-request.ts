// Account deletion: apply, cancel, read (task B1-15d; 08 BR-ID-27, BR-ID-08, BR-ID-31; contract
// operations requestDeletion / cancelDeletion / getDeletion). NotImplemented skeleton written by
// the rule-test author; the implementer fills it in (and may reshape the internals as long as the
// rule tests in test/spec/identity/deletion-request/** hold).
//
// request(trx, subject) — called inside the idempotency claim's transaction (executeInTransaction,
// wrapped by withStepUp in the controller). Fixed order (§9.2 #3):
//   ① lockUsersForUpdate on the caller; ② TODO(规划/11 §2.3) pending-reverify code — blocked;
//   ③ latest request (apply_at DESC, id DESC) cooling / processing → return it (no new row,
//      cooling_until unchanged); ④ withdrawalInFlight.hasInFlight → 30412 (before 30416);
//   ⑤ balance.availableFen < 0 → 30416, data.amount_fen = -available_fen (positive bigint);
//   ⑥ insert: UUIDv7 id, status 'cooling' (an insert, not a transition), apply_at = clock.now(),
//      cooling_until = apply_at + 604 800 000 ms, balance_snapshot_fen = available_fen, row_version
//      0, created_at / updated_at = the Clock value; ⑦ return the request (can_cancel true).
// cancel(subject) — one transaction: lock the caller, read the latest request:
//   cooling and now < cooling_until → transitionDeletionRequest('cooling', 'CANCEL'), conditional
//   update (id + row_version): cancelled, cancelled_at = now, cancel_reason 'user';
//   cooling and now ≥ cooling_until, processing (and done, defensively) → 10007 stage processing;
//   cancelled → returned as it is; none → data null.
// read(subject) — the latest request or null; can_cancel = cooling and clock.now() < cooling_until.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { FactoryProvider } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { DeletionBalanceReader } from '../ports/deletion-balance.ts';
import type { WithdrawalInFlightReader } from '../ports/withdrawal-in-flight.ts';

/**
 * The two IdentityModuleOptions entries app.module assembles for this flow (useFactory style like
 * the other options). Missing (undefined or a factory answering null) → POST /v1/me/deletion
 * answers 50001; it never lets an application through unchecked.
 */
export interface DeletionRequestModuleOptions {
  readonly withdrawalInFlight?: Omit<FactoryProvider<WithdrawalInFlightReader | null>, 'provide'>;
  readonly deletionBalance?: Omit<FactoryProvider<DeletionBalanceReader | null>, 'provide'>;
}

export type DeletionView = components['schemas']['Deletion'];

export interface DeletionSubject {
  readonly appId: string;
  readonly userId: string;
}

export type RequestDeletionResult =
  | { readonly code: 0; readonly data: DeletionView }
  | { readonly code: 30412 }
  | { readonly code: 30416; readonly data: { readonly amount_fen: bigint } };

export type CancelDeletionResult =
  | { readonly code: 0; readonly data: DeletionView | null }
  | { readonly code: 10007; readonly data: { readonly stage: 'processing' } };

export interface DeletionRequestServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly withdrawalInFlight: WithdrawalInFlightReader;
  readonly balance: DeletionBalanceReader;
}

export interface DeletionRequestService {
  read(subject: DeletionSubject): Promise<DeletionView | null>;
  request(trx: Transaction<DB>, subject: DeletionSubject): Promise<RequestDeletionResult>;
  cancel(subject: DeletionSubject): Promise<CancelDeletionResult>;
}

export function createDeletionRequestService(
  options: DeletionRequestServiceOptions,
): DeletionRequestService {
  void options;
  throw new Error('NotImplemented: createDeletionRequestService');
}

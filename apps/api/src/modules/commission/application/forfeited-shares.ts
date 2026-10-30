// B1-03z: commission's read-only port for risk's appeal restore producer (08 BR-FUND-22, BR-CALC-13
// 细则「申诉恢复」, 拍板第二批 FUND-14). Skeleton of the test stage: the rule tests in
// test/spec/risk/appeal-restore/** import this file by path; the names, signatures and semantics
// written here are the contract.
//
// listBannedForfeitedShares(trx, { appId, userId, since, until })
//   - Plain SELECTs on the given handle (the caller's transaction); writes nothing, opens no
//     connection or transaction, publishes nothing, logs nothing. Reads only commission's tables
//     (commission_split_beneficiary_events, the split snapshot tables).
//   - Returns one item per share (order_id, role) of `userId` in `appId` that has a forfeited event
//     with reason 'banned' whose created_at lies within [since, until] (both ends inclusive).
//     Forfeited events with reason 'deleted' or 'minor' are never returned (BR-CALC-13: 注销、未成年
//     导致的 forfeited 不恢复); neither are active / held events, other users or other apps.
//   - amountFen: the share's value (份额金额) from the split snapshot — commission_split_amounts
//     amount_fen of (order_id, user_id, role). Which commission_version is used (suggested: the
//     largest one of the order) is the implementation's choice, written down here with its source.
//   - forfeitedAt: created_at of that forfeited event (the latest one in the window when there are
//     several for the same share).
//   - orderKey: the sub-order's order key `{platform}:{sub_order_id}` (order_keys of order_id), the
//     key of its FORFEIT voucher and the restore difference's ref_id.
//   - Order: forfeitedAt ascending, then orderId, then role. Nothing found: [].
//
// findBannedRunStart(trx, { appId, userId, until, notBefore })
//   - Plain SELECTs on the given handle, like listBannedForfeitedShares; writes nothing.
//   - The start of the member's last unbroken run of banned forfeitures among the member's share
//     events (commission_split_beneficiary_events of `userId` in `appId`) with created_at in
//     (notBefore, until] — notBefore exclusive (null: no lower bound), until inclusive. Any other
//     share event of the member (active, held, forfeited with reason deleted / minor) breaks the
//     run; other members' events never join or break it. Returns the created_at of the run's
//     earliest banned forfeiture; no banned forfeiture in (notBefore, until] → null.
//   - Used by risk's appeal restore producer for appeals without penalty_started_at (存量).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Beneficiary roles of commission_split_beneficiary_events (推广 / 自购份额). */
export type ForfeitedShareRole = 'self' | 'share' | 'direct' | 'indirect';

export interface ListBannedForfeitedSharesInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive lower bound of the forfeited event's created_at. */
  readonly since: Date;
  /** Inclusive upper bound of the forfeited event's created_at. */
  readonly until: Date;
}

export interface BannedForfeitedShare {
  readonly orderId: string;
  /** The sub-order's order key `{platform}:{sub_order_id}` (order_keys). */
  readonly orderKey: string;
  readonly role: ForfeitedShareRole;
  /** The forfeited share's value in fen (split snapshot). */
  readonly amountFen: bigint;
  /** created_at of the share's forfeited (banned) event inside the window. */
  readonly forfeitedAt: Date;
}

/** BR-CALC-13 细则「申诉恢复」: the user's shares forfeited for a ban within [since, until]. */
export async function listBannedForfeitedShares(
  trx: Kysely<DB>,
  input: ListBannedForfeitedSharesInput,
): Promise<readonly BannedForfeitedShare[]> {
  void trx;
  void input;
  throw new Error('NotImplemented: listBannedForfeitedShares');
}

export interface FindBannedRunStartInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive upper bound of the share events' created_at. */
  readonly until: Date;
  /** Exclusive lower bound of the share events' created_at; null: none. */
  readonly notBefore: Date | null;
}

/** Start of the member's last unbroken run of banned forfeitures; none → null. */
export async function findBannedRunStart(
  trx: Kysely<DB>,
  input: FindBannedRunStartInput,
): Promise<Date | null> {
  void trx;
  void input;
  throw new Error('NotImplemented: findBannedRunStart');
}

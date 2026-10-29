// B2-05e: withdraw_holds (规划/08 BR-WDR-05 提现冻结记录): reasons stack, each hold is released on
// its own; "in effect" = released_at is null and (hold_until is null or still ahead of the clock),
// judged where the holds are read (B2-05c holdActive, the in-flight reader here). Every change
// locks identity's users row first (BR-WDR-07 lock order; add and release of the same user never
// interleave) and is audited through platform's AuditPort on the same transaction (an audit
// failure rolls the change back). No logging of the user.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { newUuidV7, type AuditPort, type Clock } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';

export interface WithdrawHoldsOptions {
  clock: Clock;
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  audit: AuditPort;
}
export interface AddWithdrawHold {
  appId: string;
  userId: string;
  reason: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
  sourceRef: string | null;
  createdBy: string;
  holdUntil: Date | null;
}
export interface WithdrawHolds {
  add(trx: Transaction<DB>, input: AddWithdrawHold): Promise<{ id: string }>;
  /**
   * `appId` is the caller's tenant (server-side, BR-AI-03): a hold of another app is treated as
   * unknown. Callers inside the tenant's own flows may omit it (the row's app is then the scope).
   */
  release(
    trx: Transaction<DB>,
    input: { holdId: string; releasedBy: string; appId?: string },
  ): Promise<void>;
}

export function createWithdrawHolds(options: WithdrawHoldsOptions): WithdrawHolds {
  const { clock, audit } = options;
  return {
    async add(trx, input) {
      await options.lockUsersForUpdate(trx, { appId: input.appId, userIds: [input.userId] });
      const now = clock.now();
      const id = newUuidV7(now);
      await trx
        .withSchema('app')
        .insertInto('withdraw_holds')
        .values({
          id,
          app_id: input.appId,
          user_id: input.userId,
          reason: input.reason,
          source_ref: input.sourceRef,
          created_by: input.createdBy,
          created_at: now,
          hold_until: input.holdUntil,
        })
        .execute();
      await audit.append({
        appId: input.appId,
        actor: input.createdBy,
        action: 'withdraw_hold.add',
        target: id,
        before: null,
        after: {
          user_id: input.userId,
          reason: input.reason,
          source_ref: input.sourceRef,
          hold_until: input.holdUntil === null ? null : input.holdUntil.toISOString(),
        },
        ip: null,
      });
      return { id };
    },
    async release(trx, input) {
      let query = trx
        .withSchema('app')
        .selectFrom('withdraw_holds')
        .select(['id', 'app_id', 'user_id', 'reason', 'released_at'])
        .where('id', '=', input.holdId);
      if (input.appId !== undefined) query = query.where('app_id', '=', input.appId);
      const hold = await query.executeTakeFirst();
      if (hold === undefined) throw new Error('payout: withdraw hold not found');
      await options.lockUsersForUpdate(trx, { appId: hold.app_id, userIds: [hold.user_id] });
      if (hold.released_at !== null) return;
      const now = clock.now();
      await trx
        .withSchema('app')
        .updateTable('withdraw_holds')
        .set({ released_at: now, released_by: input.releasedBy })
        .where('app_id', '=', hold.app_id)
        .where('id', '=', hold.id)
        .where('released_at', 'is', null)
        .execute();
      await audit.append({
        appId: hold.app_id,
        actor: input.releasedBy,
        action: 'withdraw_hold.release',
        target: hold.id,
        before: { reason: hold.reason, released_at: null },
        after: { reason: hold.reason, released_at: now.toISOString() },
        ip: null,
      });
    },
  };
}

/** B2-09b: the holds of one source (a recon diff being closed), released together. */
export interface ReleaseWithdrawHoldsBySource {
  appId: string;
  /** Matched exactly against withdraw_holds.source_ref (`recon_diff:<recon_diffs.id>`, B2-07c). */
  sourceRef: string;
  releasedBy: string;
}

/**
 * B2-09b skeleton (rule-test phase): every hold of the app whose source_ref is exactly
 * `sourceRef` and released_at is null is released through the same steps as `release` (users row
 * locks first, in user_id order; one withdraw_hold.release audit per hold on the same
 * transaction); holds released earlier are skipped. `released` = the holds this call released.
 * The implementation may fold this into WithdrawHolds as `releaseBySource(trx, input)`.
 */
export function releaseWithdrawHoldsBySource(
  options: WithdrawHoldsOptions,
  trx: Transaction<DB>,
  input: ReleaseWithdrawHoldsBySource,
): Promise<{ released: number }> {
  void options;
  void trx;
  void input;
  throw new Error('NotImplemented: releaseWithdrawHoldsBySource');
}

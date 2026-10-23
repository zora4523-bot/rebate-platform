// B2-06c: the EXECUTE command (规划/08 BR-WDR-12, BR-WDR-11, BR-WDR-18, BR-WDR-05; state machine W4).
// executeBatch(trx, input) groups the members into a new batch (kind=manual for an admin,
// kind=auto for 'system:auto_payout', one withdrawal) and executes it on the caller's transaction:
//   ① batch level, refusing the whole batch: payout.enabled on, payout.queue_paused off
//      → { kind: 'rejected', reason: 'payout_disabled' | 'queue_paused' }.
//   ② per withdrawal, under FOR UPDATE: still APPROVED (else skipped / not_approved); no withdrawal
//      block of the member (BR-WDR-05: risk state frozen / banned / appealing over either, an
//      effective withdraw hold, available_fen < 0, blocked_reason set → blocked / member_blocked);
//      no kind=transfer attempt of any result (blocked / has_transfer_attempt); the snapshot
//      channel enabled and not paused (payout.channel_enabled.<channel> on,
//      payout.channel_paused.<channel> off; else blocked / channel_disabled).
//   ③ the watermark of the executable set, per channel (domain/watermark.ts); any channel failing
//      → { kind: 'rejected', reason, channel }.
// A rejection moves no withdrawal, writes no item, enqueues nothing. Otherwise each executable
// withdrawal: CAS APPROVED → PAYING through transitionWithdrawal(…, 'EXECUTE') with execute_seq + 1,
// executor_id (null for the system), batch_id, executed_at = now, row_version + 1 (0 rows →
// skipped / not_approved, no throw); an item 'paying'; JobQueue.send('payout', 'transfer',
// { withdrawal_id, execute_seq, app_id }, { trx, singletonKey: `${withdrawal_id}:${execute_seq}` });
// wallet.withdrawal_changed. A manual member already on another batch is moved first by a CAS on
// (status = APPROVED, batch_id = the old batch), the old batch getting an item 'moved_out'.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { EventBus, JobQueue } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { WatermarkRejectReason } from '../domain/watermark.ts';
import type { PayoutChannelName } from './watermark.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The executor of an automatic batch (BR-WDR-30): no admin, executor_id stays null. */
export type SystemAutoPayoutExecutor = 'system:auto_payout';

/** Why a member stays where it is (payout_batch_items.reason, the admin list's result column). */
export type PayoutLeftReason =
  | 'not_approved'
  | 'member_blocked'
  | 'has_transfer_attempt'
  | 'channel_disabled'
  | WatermarkRejectReason;

export type PayoutBatchRejectReason = 'payout_disabled' | 'queue_paused' | WatermarkRejectReason;

export interface ExecuteBatchInput {
  appId: string;
  /** The ticked withdrawals; exactly one for an automatic batch. */
  members: readonly string[];
  /** The admin's id (kind=manual), or 'system:auto_payout' (kind=auto). */
  executorId: string;
  /** The caller's Clock instant; every time written or compared comes from it. */
  now: Date;
}

export type ExecuteBatchResult =
  | {
      kind: 'executed';
      batchId: string;
      paying: string[];
      left: { id: string; reason: PayoutLeftReason }[];
    }
  | {
      kind: 'rejected';
      reason: PayoutBatchRejectReason;
      /** The failing channel of a watermark rejection. */
      channel?: PayoutChannelName;
    };

export interface PayoutExecuteOptions {
  /** content's configuration reader (payout.* switches and payout.watermark_usable_bp). */
  config: PayoutConfigPort;
  risk: RiskStateBatchReader;
  appeal: AppealPrevStateReader;
  ledger: Pick<Ledger, 'getBalances' | 'lockBalances'>;
  queue: JobQueue;
  eventBus: EventBus;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
}

export interface PayoutExecute {
  executeBatch(trx: Transaction<DB>, input: ExecuteBatchInput): Promise<ExecuteBatchResult>;
}

export function createPayoutExecute(options: PayoutExecuteOptions): PayoutExecute {
  void options;
  throw new Error('NotImplemented: createPayoutExecute');
}

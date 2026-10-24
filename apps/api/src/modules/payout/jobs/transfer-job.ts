// B2-06d: the transfer job of the payout process (规划/08 BR-WDR-13 ①–⑤, BR-WDR-14, BR-WDR-17,
// BR-WDR-28, BR-WDR-09; state machine W5 / W6 / W9; 规划/12 §5.4). createTransferJob(options) is the
// handler of queue `payout`, job name `transfer`, payload TransferJobPayload (registered by B2-06f;
// the queue works it with concurrency 1). Strict order:
//   ① read the withdrawal (app_id and id of the payload, row lock). Missing, status ≠ PAYING or
//      execute_seq ≠ the payload's → resolve; nothing written, no channel call, no query.
//   ② any kind=transfer attempt of the withdrawal (whatever its result) → no transfer; enqueue the
//      first query job (below) and resolve. The attempt row is left as it is.
//   ③ inside pg_advisory_xact_lock(hashtext('payout_daily:' || app_id)) the review of
//      application/payout-review.ts (switches read from PG through `config`). A failing check → W9
//      on that transaction: transitionWithdrawal(PAYING, 'HOLD') → APPROVED by CAS on row_version,
//      hold_reason, hold_at = Clock.now, executor_id and executed_at cleared, batch_id and
//      execute_seq kept, wallet.withdrawal_changed; member_blocked also enqueues one negative
//      balance recheck on the same transaction:
//        queue.send('evt.payout-went-negative', <job name>, { app_id, user_id }, { trx })
//      No attempt, no voucher, no channel call.
//   ④ still inside the lock: insert payout_attempts (kind transfer, result pending, request = a
//      masked summary without the payee's account or name, at = Clock.now) and commit it, so the
//      row is visible to any other connection before ⑤ and the lock is released before ⑤.
//   ⑤ outside any transaction: channels[payout_channel].transfer({ outBizNo: out_biz_no, netFen:
//      net_fen, payee: { identity: decryptPayee(payee_account_cipher, payout_method), name:
//      payee_name }, channel }) (the 10-second timeout lives in the channel). A rejection of any
//      kind (timeout, network) is an unknown result; the handler never rethrows it and never calls
//      transfer again (the job resolves, so the queue does not retry).
// Landing the synchronous result: the pending attempt row is completed once (response, resp_code,
// resp_sub_code, result, latency_ms) and, on the business handle:
//   success     W5 CHANNEL_SUCCESS → PAID_API: channel_order_id, paid_at (the channel's time when
//               given, else Clock.now); the voucher WITHDRAW:SUCCESS:CASH_<ALIPAY|BANK|WECHAT>
//               `wd:{id}:PAID` through ledger.post on the same transaction (zero fee / tax lines
//               omitted); attempt success.
//   fail        W6 CHANNEL_FAIL → FAILED: fail_code = sub_code; WITHDRAW:RETURN `wd:{id}:RETURN`;
//               attempt fail.
//   payer_side  W9 → APPROVED with hold_reason payer_side_after_transfer (no refund, frozen stays);
//               pauseQueue.pause on the same transaction; alert; attempt fail.
//   unknown     stays PAYING; attempt unknown; with pauseQueue (a code outside the three lists)
//               also pauseQueue.pause and the alert. Then the first query job (below).
// The first query job (BR-WDR-14; consumed by B2-06e), on the transaction of that step:
//   queue.send('payout', 'query', { withdrawal_id, execute_seq, app_id, point: 0 },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:query:0`,
//       delaySeconds: payout.query_schedule.points_min[0] × 60 })
// Every transition goes through the generated transitionWithdrawal() with a CAS on status and
// row_version; 0 rows → logger.warn, nothing else written for it, no retry, no throw. Only
// database errors before ⑤ may reject (a redelivery is then stopped by ① / ②).
// Alert: logger.warn(fields, 'payout_queue_paused') with withdrawal_id, out_biz_no, code, sub_code
// and cause ('payer_side' | 'unknown_code'). Logs carry withdrawal_id, out_biz_no, code, sub_code,
// hold_reason, latency_ms only — never the payee's account or name.
//
// Database roles: `db` is the business handle (withdrawals, ledger, config, events, jobs);
// `attemptsDb` connects as couli_payout, the only role that inserts payout_attempts and completes
// them (couli_app has SELECT only). A row lock the business transaction holds on the withdrawal
// must not block the attempt insert's foreign key check (FOR NO KEY UPDATE, not FOR UPDATE).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { DecryptWithdrawalAccount } from '../application/withdrawal-reads.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';

/** The payload EXECUTE enqueues (BR-WDR-12; singletonKey `${withdrawal_id}:${execute_seq}`). */
export interface TransferJobPayload {
  readonly withdrawal_id: string;
  readonly execute_seq: number;
  readonly app_id: string;
}

/** The first query job's payload (B2-06e consumes it). */
export interface QueryJobPayload extends TransferJobPayload {
  readonly point: number;
}

export interface PayoutQueuePauseInput {
  readonly appId: string;
  /** Machine-readable origin, e.g. 'payout_transfer'. */
  readonly source: string;
  readonly reason: string;
}

/** content's system write of payout.queue_paused = true, on the caller's transaction. */
export interface PayoutQueuePausePort {
  pause(trx: Transaction<DB>, input: PayoutQueuePauseInput): Promise<{ readonly changed: boolean }>;
}

export type TransferAlertMessage = 'payout_queue_paused';
export type TransferAlertCause = 'payer_side' | 'unknown_code';

export interface TransferJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface TransferJobOptions {
  /** Business handle: withdrawals, ledger, config, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  /** couli_payout handle: the only writer of payout_attempts. */
  readonly attemptsDb: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.* switches, caps and query_schedule), direct PG. */
  readonly config: PayoutConfigPort;
  readonly risk: RiskStateBatchReader;
  readonly appeal: AppealPrevStateReader;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /** One adapter per opened channel (B2-06b); FakeChannel outside prod. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
  /** The process's field cipher: the payee account of the withdrawal's snapshot. */
  readonly decryptPayee: DecryptWithdrawalAccount;
  readonly pauseQueue: PayoutQueuePausePort;
  readonly logger: TransferJobLogger;
}

export function createTransferJob(options: TransferJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createTransferJob');
}

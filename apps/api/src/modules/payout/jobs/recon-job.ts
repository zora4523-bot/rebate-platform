// B2-07c: the worker's daily R2 reconciliation of the payout channel (规划/08 BR-WDR-23, BR-WDR-15,
// BR-FUND-24; 编排裁定 D10-408). Handler of queue `payout-recon` (worker entry, couli_app), job
// `recon`, payload PayoutReconJobPayload { app_id, channel: 'alipay', bill_date } (bill_date: the
// +08:00 accounting day reconciled, run T+1). Contract of the rule tests (test/spec/payout/recon-channel):
//   - The channel's bill of bill_date (bills[channel].billDetails) is matched with the app's
//     withdrawals: a line with an out_biz_no by out_biz_no, a manual success (PAID_MANUAL) by
//     channel_order_id; the line's amount is compared with net_fen. One app.recon_channel row per
//     line / per PAID_* withdrawal of the day (date = bill_date reconciled, bill_date = the bill the
//     line was read from), result matched / paying_query / paying_manual / diff.
//   - ① line success, ours PAYING with needs_manual = false → an immediate query through the
//     existing query chain (queue `payout`, job `query`); a result that is not a success ends with
//     needs_manual = true, an R2 recon diff and an alert (then BR-WDR-15).
//   - ② line success, ours PAYING with needs_manual = true → only the row (with the bill line) and a
//     pending-disposal hint; W10 ends it.
//   - ③ line success and ours APPROVED / FAILED / REJECTED or none; ours PAID_* and no line (near the
//     day boundary: neither paid_at's day's bill nor the next day's); amounts differ → recon_diffs
//     (source R2, type channel_mismatch, deduplicated), an alert and, for the member, withdraw_holds
//     reason recon_diff without hold_until; an APPROVED withdrawal returned by W9 gets the bill line
//     on its diff.
//   - Terminal withdrawals are read only (corrections go through a diff and an adjustment,
//     BR-FUND-24). Every run writes app.payout_recon_runs (app_id, channel, bill_date): succeeded
//     when the day ran to its end (diffs found included), partial / failed when the bill could not
//     be had or the run failed — never succeeded on a missing bill. A rerun of the same day changes
//     nothing that already holds; each day's run enqueues the next day's.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import type { WithdrawHolds } from '../application/withdraw-holds.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';

/** The worker's queue of the reconciliation (platform/queue catalog and worker plan). */
export type PayoutReconQueue = 'payout-recon';

/** The daily run of one (app, channel, bill day). */
export type PayoutReconJobName = 'recon';

/** R2 reconciles Alipay only for now (D10-408). */
export type PayoutReconChannel = 'alipay';

export interface PayoutReconJobPayload {
  readonly app_id: string;
  readonly channel: PayoutReconChannel;
  /** YYYY-MM-DD, the +08:00 accounting day of the bill. */
  readonly bill_date: string;
}

export interface PayoutReconLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The bill reader of a channel: an adapter without billDetails has no bill (unavailable). */
export type PayoutBillPort = Pick<PayoutChannel, 'billDetails'>;

export interface PayoutReconJobOptions {
  /** couli_app: withdrawals (read only), recon_channel, payout_recon_runs, recon diffs, holds, jobs. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.*), direct PG. */
  readonly config: PayoutConfigPort;
  readonly queue: JobQueue;
  /** The bill port of each reconciled channel. */
  readonly bills: Readonly<Partial<Record<PayoutChannelName, PayoutBillPort>>>;
  /** withdraw_holds (reason recon_diff) under the users lock, audited. */
  readonly holds: WithdrawHolds;
  readonly logger: PayoutReconLogger;
}

export function createPayoutReconJob(options: PayoutReconJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createPayoutReconJob');
}

// B2-06f (D10-398 ①): the worker's BR-WDR-13 ③ review of a transfer. The payout process
// (couli_payout) reads neither users nor balances: its transfer job, past ① and ②, enqueues
//   queue.send('payout-review', 'review', { app_id, withdrawal_id, execute_seq },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:review` })
// and this handler (worker, couli_app) re-reads the withdrawal (① again: missing, status ≠ PAYING
// or execute_seq ≠ the payload's → resolve, nothing written) and reviews, in the order of 08 ③,
// payout_disabled → queue_paused → channel_disabled → member_blocked (BR-WDR-05, under the users →
// balances locks). The first failing check is W9 on that transaction (PAYING → APPROVED with
// hold_reason, as the transfer job's hold; member_blocked also enqueues the negative balance
// recheck). All pass → one `release` job back on queue `payout`, on the same transaction:
//   queue.send('payout', 'release', { app_id, withdrawal_id, execute_seq },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:release` })
// The payout process's release then re-checks ①, payout_disabled / queue_paused /
// channel_disabled and single_cap / daily_cap inside the payout_daily lock before ④ / ⑤.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { TransferJobLogger } from './transfer-job.ts';

/** The payload of `review` and of `release`. */
export interface PayoutReviewPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly execute_seq: number;
}

export interface ReviewJobOptions {
  /** couli_app: withdrawals, users, balances, config, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: PayoutConfigPort;
  readonly risk: RiskStateBatchReader;
  readonly appeal: AppealPrevStateReader;
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  readonly logger: TransferJobLogger;
}

export function createReviewJob(options: ReviewJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createReviewJob');
}

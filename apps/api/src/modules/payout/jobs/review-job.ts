// B2-06f (D10-398 ①): the worker's BR-WDR-13 ③ review of a transfer. The payout process
// (couli_payout) reads neither users nor balances: its transfer job, past ① and ②, enqueues
//   queue.send('payout-review', 'review', { app_id, withdrawal_id, execute_seq },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:review` })
// and this handler (worker, couli_app) re-reads the withdrawal (① again: missing, status ≠ PAYING
// or execute_seq ≠ the payload's → resolve, nothing written) and reviews, in the order of 08 ③,
// payout_disabled → queue_paused → channel_disabled → member_blocked (BR-WDR-05, under the users →
// balances locks). The first failing check is W9 on that transaction (PAYING → APPROVED with
// hold_reason, application/transfer-gates.ts; member_blocked also enqueues the negative balance
// recheck). All pass → one `release` job back on queue `payout`, on the same transaction:
//   queue.send('payout', 'release', { app_id, withdrawal_id, execute_seq },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:release` })
// The payout process's release then re-checks ①, payout_disabled / queue_paused /
// channel_disabled and single_cap / daily_cap inside the payout_daily lock before ④ / ⑤. A member
// blocked after this commit and before the release runs (one queue round trip) is not re-checked
// there (D10-398 ③).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { TransferHoldReason } from '../application/payout-review.ts';
import {
  SWITCH_DEFAULTS,
  channelSwitchesOpen,
  holdWithdrawal,
  isChannel,
  readSwitch,
} from '../application/transfer-gates.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import {
  PAYOUT_QUEUE,
  PAYOUT_RELEASE_JOB,
  PAYOUT_REVIEW_JOB,
  PAYOUT_REVIEW_QUEUE,
  PAYOUT_WENT_NEGATIVE_JOB,
  PAYOUT_WENT_NEGATIVE_QUEUE,
  parseTransferPayload,
  type TransferJobLogger,
} from './transfer-job.ts';

export { PAYOUT_RELEASE_JOB, PAYOUT_REVIEW_JOB, PAYOUT_REVIEW_QUEUE };

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

const PAYING = 'PAYING';

interface ReviewRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly execute_seq: number;
  readonly row_version: number;
  readonly out_biz_no: string;
  readonly payout_channel: string;
  readonly blocked_reason: string | null;
}

export function createReviewJob(options: ReviewJobOptions): JobHandler {
  const { db, clock, config, risk, appeal, ledger, lockUsersForUpdate, queue, eventBus, logger } =
    options;

  /** BR-WDR-05: the member's withdrawal block, under the users → balances locks of `trx`. */
  async function memberBlocked(trx: Transaction<DB>, row: ReviewRow, now: Date): Promise<boolean> {
    if (row.blocked_reason !== null) return true;
    await lockUsersForUpdate(trx, { appId: row.app_id, userIds: [row.user_id] });
    const balances = await ledger.lockBalances(trx, { appId: row.app_id, userIds: [row.user_id] });
    const own = balances.find((balance) => balance.user_id === row.user_id);
    if (own !== undefined && own.available_fen < 0n) return true;
    const states = await risk.read(trx, { appId: row.app_id, userIds: [row.user_id] });
    const state = states.get(row.user_id) ?? { state: 'normal', frozen_until: null };
    const expired =
      state.state === 'frozen' &&
      state.frozen_until !== null &&
      state.frozen_until.getTime() <= now.getTime();
    if (!expired && (state.state === 'frozen' || state.state === 'banned')) return true;
    if (state.state === 'appealing') {
      const prev = await appeal.read(trx, { appId: row.app_id, userId: row.user_id });
      if (prev === 'frozen' || prev === 'banned') return true;
    }
    const hold = await trx
      .withSchema('app')
      .selectFrom('withdraw_holds')
      .select('id')
      .where('app_id', '=', row.app_id)
      .where('user_id', '=', row.user_id)
      .where('released_at', 'is', null)
      .where((eb) => eb.or([eb('hold_until', 'is', null), eb('hold_until', '>', now)]))
      .limit(1)
      .executeTakeFirst();
    return hold !== undefined;
  }

  /** The first failing check in the order of 08 ③, or null when all four pass. */
  async function firstFailing(
    trx: Transaction<DB>,
    row: ReviewRow,
    now: Date,
  ): Promise<TransferHoldReason | null> {
    const appId = row.app_id;
    if (!(await readSwitch(config, logger, trx, appId, 'payout.enabled', SWITCH_DEFAULTS.enabled)))
      return 'payout_disabled';
    if (
      await readSwitch(
        config,
        logger,
        trx,
        appId,
        'payout.queue_paused',
        SWITCH_DEFAULTS.queuePaused,
      )
    )
      return 'queue_paused';
    const channel = isChannel(row.payout_channel) ? row.payout_channel : null;
    if (channel === null || !(await channelSwitchesOpen(config, logger, trx, appId, channel)))
      return 'channel_disabled';
    if (await memberBlocked(trx, row, now)) return 'member_blocked';
    return null;
  }

  return async function reviewJob(job: ReceivedJob): Promise<void> {
    const payload = parseTransferPayload(job);
    if (payload === null || job.name !== PAYOUT_REVIEW_JOB) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_review_bad_job');
      return;
    }
    const now = clock.now();
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select([
          'id',
          'app_id',
          'user_id',
          'status',
          'execute_seq',
          'row_version',
          'out_biz_no',
          'payout_channel',
          'blocked_reason',
        ])
        .where('app_id', '=', payload.app_id)
        .where('id', '=', payload.withdrawal_id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (row === undefined || row.status !== PAYING || row.execute_seq !== payload.execute_seq) {
        logger.info(
          {
            withdrawal_id: payload.withdrawal_id,
            execute_seq: payload.execute_seq,
            status: row?.status ?? null,
          },
          'payout_review_skipped',
        );
        return;
      }
      const reason = await firstFailing(trx, row, now);
      if (reason !== null) {
        const held = await holdWithdrawal(trx, { eventBus, logger }, row, reason, now);
        if (held && reason === 'member_blocked') {
          await queue.send(
            PAYOUT_WENT_NEGATIVE_QUEUE,
            PAYOUT_WENT_NEGATIVE_JOB,
            { app_id: row.app_id, user_id: row.user_id },
            { trx },
          );
        }
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, hold_reason: reason },
          'payout_transfer_held',
        );
        return;
      }
      await queue.send(
        PAYOUT_QUEUE,
        PAYOUT_RELEASE_JOB,
        { app_id: row.app_id, withdrawal_id: row.id, execute_seq: row.execute_seq },
        { trx, singletonKey: `${row.id}:${row.execute_seq}:release` },
      );
      logger.info({ withdrawal_id: row.id, out_biz_no: row.out_biz_no }, 'payout_review_released');
    });
  };
}

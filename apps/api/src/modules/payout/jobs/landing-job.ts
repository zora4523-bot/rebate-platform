// B2-06fz (D10-326 option C; 规划/02 §5.3 P→A; 规划/08 BR-WDR-13, BR-WDR-14, BR-WDR-09; state
// machine W5 / W6): landing a channel result on the worker (couli_app). The payout process only
// connects as couli_payout, which has no grant on the ledger or users tables, so its transfer and
// query jobs only record the attempt's result and, on the same couli_payout transaction, enqueue
//   queue.send('payout-landing', 'land', { app_id, withdrawal_id, execute_seq, attempt_id },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:land:${attempt_id}` })
// for an attempt whose result is success or fail (response.kind success / fail; a payer-side
// result is W9 on the payout process and is never enqueued). The attempt row's `response` also
// carries channel_order_id, paid_at (the channel's time), status (the channel's status before
// the query_status_map mapping) and received_at (Clock, ISO: when the result came back; a
// transfer attempt's `at` is written before the send). Before it enqueues, the payout process
// re-reads the withdrawal on that transaction: row_version not the one it read at its ①, or no
// longer PAYING / another execute_seq / needs_manual → it only records the attempt and warns
// (payout_landing_skipped), no land job; W10 ends the withdrawal.
//
// createLandingJob(options) is the handler of queue `payout-landing`, job name `land`, payload
// LandingJobPayload (registered by PayoutModule.forWorker; worker entry, concurrency 1). Order:
//   ① read the withdrawal (app_id and id of the payload, no lock) for its user_id →
//      lockUsersForUpdate → read it again FOR NO KEY UPDATE. Missing, another app, status ≠
//      PAYING or execute_seq ≠ the payload's → resolve (info), nothing written. needs_manual =
//      true → resolve, nothing written: after T + 24 h only W10 ends it (BR-WDR-14).
//   ② read the attempt row `attempt_id`: not this withdrawal's (or missing), result ∉
//      { success, fail }, or response.kind ∉ { success, fail } (payer_side is stored as result
//      fail) → logger.warn and resolve, nothing written.
//   ③ success → W5 through application/payout-landing.ts: paid_at = response.paid_at (the
//      channel's time) when it is an instant, else response.received_at, else the attempt row's
//      `at`; channel_order_id = response.channel_order_id; WITHDRAW:SUCCESS:CASH_<channel>
//      `wd:{id}:PAID`.
//      fail → W6 through application/payout-landing.ts: fail_code = resp_sub_code, else
//      response.status, else resp_code; WITHDRAW:RETURN `wd:{id}:RETURN`.
//      Transition, voucher and wallet.withdrawal_changed on one transaction; a CAS that moves no
//      row (row_version changed) only warns: no transition, no voucher, no event, no throw.
// A redelivery, or a second landing job of the same withdrawal (a transfer success followed by a
// query success), stops at ① once the withdrawal left PAYING: the voucher is posted once.
// Logs carry withdrawal_id, attempt_id, out_biz_no and codes only — never the payee's account or
// name.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, ReceivedJob } from '../../platform/index.ts';
import {
  PAYOUT_LANDING_JOB,
  PAYOUT_LANDING_QUEUE,
  type LandingJobPayload,
} from '../application/landing-handoff.ts';
import { createPayoutLanding, instant } from '../application/payout-landing.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { ChannelRaw } from '../domain/channel-result.ts';

export { PAYOUT_LANDING_JOB, PAYOUT_LANDING_QUEUE };
export type { LandingJobPayload };

/** Queue and job name of a landing (platform/queue/catalog.ts; worker entry only). */
export type PayoutLandingQueue = 'payout-landing';
export type PayoutLandingJobName = 'land';

/** The attempt row a landing reads (payout_attempts; couli_app may SELECT it). */
export interface LandingAttempt {
  readonly id: string;
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly kind: string;
  readonly result: string;
  readonly response: unknown;
  readonly resp_code: string | null;
  readonly resp_sub_code: string | null;
  readonly at: Date;
}

/** Reads one attempt row; default: payout_attempts on the landing's own handle. */
export interface LandingAttemptsReader {
  attempt(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly attemptId: string },
  ): Promise<LandingAttempt | null>;
}

export interface LandingJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LandingJobOptions {
  /** couli_app: withdrawals, ledger, events. */
  readonly db: Kysely<DB>;
  readonly attemptsReader?: LandingAttemptsReader;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → withdrawal → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly logger: LandingJobLogger;
}

const PAYING = 'PAYING';

interface LandingRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly execute_seq: number;
  readonly row_version: number;
  readonly needs_manual: boolean;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly out_biz_no: string;
  readonly payout_channel: string;
}

/** The parts of an attempt's `response` JSON the landing reads (written by the payout process). */
interface RecordedResponse {
  readonly raw: ChannelRaw;
  readonly kind: string;
  readonly status?: string;
  readonly channelOrderId?: string;
  readonly paidAt?: string;
  readonly receivedAt?: string;
}

function parsePayload(job: ReceivedJob): LandingJobPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const appId = payload['app_id'];
  const withdrawalId = payload['withdrawal_id'];
  const executeSeq = payload['execute_seq'];
  const attemptId = payload['attempt_id'];
  if (
    typeof appId !== 'string' ||
    appId === '' ||
    typeof withdrawalId !== 'string' ||
    withdrawalId === '' ||
    typeof attemptId !== 'string' ||
    attemptId === '' ||
    typeof executeSeq !== 'number' ||
    !Number.isInteger(executeSeq)
  ) {
    return null;
  }
  return {
    app_id: appId,
    withdrawal_id: withdrawalId,
    execute_seq: executeSeq,
    attempt_id: attemptId,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseResponse(value: unknown): RecordedResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record['raw'];
  const kind = record['kind'];
  if (typeof raw !== 'object' || raw === null || typeof kind !== 'string') return null;
  const code = (raw as Record<string, unknown>)['code'];
  if (typeof code !== 'string') return null;
  const subCode = text((raw as Record<string, unknown>)['subCode']);
  const response: RecordedResponse = {
    raw: subCode === undefined ? { code } : { code, subCode },
    kind,
    ...(text(record['status']) === undefined ? {} : { status: text(record['status']) as string }),
    ...(text(record['channel_order_id']) === undefined
      ? {}
      : { channelOrderId: text(record['channel_order_id']) as string }),
    ...(text(record['paid_at']) === undefined ? {} : { paidAt: text(record['paid_at']) as string }),
    ...(text(record['received_at']) === undefined
      ? {}
      : { receivedAt: text(record['received_at']) as string }),
  };
  return response;
}

/** An ISO instant's epoch milliseconds, or null when it is not one. */
function instantMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function defaultAttemptsReader(): LandingAttemptsReader {
  return {
    async attempt(executor, input) {
      const row = await executor
        .withSchema('app')
        .selectFrom('payout_attempts')
        .select([
          'id',
          'app_id',
          'withdrawal_id',
          'kind',
          'result',
          'response',
          'resp_code',
          'resp_sub_code',
          'at',
        ])
        .where('app_id', '=', input.appId)
        .where('id', '=', input.attemptId)
        .executeTakeFirst();
      return row === undefined ? null : (row as LandingAttempt);
    },
  };
}

export function createLandingJob(options: LandingJobOptions): JobHandler {
  const { db, ledger, lockUsersForUpdate, eventBus, clock, logger } = options;
  const attempts = options.attemptsReader ?? defaultAttemptsReader();
  const landing = createPayoutLanding({
    db,
    ledger,
    lockUsersForUpdate,
    eventBus,
    logger,
    conflictMessage: 'payout_landing_cas_conflict',
  });

  async function readRow(
    executor: Kysely<DB> | Transaction<DB>,
    appId: string,
    withdrawalId: string,
    lock: boolean,
  ): Promise<LandingRow | null> {
    let query = executor
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'app_id',
        'user_id',
        'status',
        'execute_seq',
        'row_version',
        'needs_manual',
        'amount_fen',
        'net_fen',
        'fee_fen',
        'tax_fen',
        'out_biz_no',
        'payout_channel',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', withdrawalId);
    if (lock) query = query.forNoKeyUpdate();
    const row = await query.executeTakeFirst();
    return row ?? null;
  }

  function stillLandable(row: LandingRow | null, payload: LandingJobPayload): row is LandingRow {
    return (
      row !== null &&
      row.status === PAYING &&
      row.execute_seq === payload.execute_seq &&
      row.needs_manual === false
    );
  }

  function skipped(payload: LandingJobPayload, row: LandingRow | null, where: string): void {
    logger.info(
      {
        withdrawal_id: payload.withdrawal_id,
        attempt_id: payload.attempt_id,
        execute_seq: payload.execute_seq,
        status: row?.status ?? null,
        needs_manual: row?.needs_manual ?? null,
        where,
      },
      'payout_landing_skipped',
    );
  }

  return async function landingJob(job: ReceivedJob): Promise<void> {
    if (job.name !== PAYOUT_LANDING_JOB) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_landing_bad_job');
      return;
    }
    const payload = parsePayload(job);
    if (payload === null) {
      logger.warn(
        { job_id: job.id, queue: job.queue, name: job.name },
        'payout_landing_bad_payload',
      );
      return;
    }
    const now = clock.now();
    // ① the user to lock comes from an unlocked read; the locks then go users → withdrawal.
    const first = await readRow(db, payload.app_id, payload.withdrawal_id, false);
    if (!stillLandable(first, payload)) {
      skipped(payload, first, 'before_lock');
      return;
    }
    await db.transaction().execute(async (trx) => {
      await lockUsersForUpdate(trx, { appId: payload.app_id, userIds: [first.user_id] });
      const row = await readRow(trx, payload.app_id, payload.withdrawal_id, true);
      if (!stillLandable(row, payload)) {
        skipped(payload, row, 'locked');
        return;
      }
      // ② the attempt the job names: this withdrawal's, settled as success or fail.
      const attempt = await attempts.attempt(trx, {
        appId: payload.app_id,
        attemptId: payload.attempt_id,
      });
      const response = attempt === null ? null : parseResponse(attempt.response);
      if (
        attempt === null ||
        attempt.withdrawal_id !== row.id ||
        response === null ||
        (response.kind !== 'success' && response.kind !== 'fail') ||
        attempt.result !== response.kind
      ) {
        logger.warn(
          {
            withdrawal_id: row.id,
            out_biz_no: row.out_biz_no,
            attempt_id: payload.attempt_id,
            attempt_withdrawal_id: attempt?.withdrawal_id ?? null,
            result: attempt?.result ?? null,
            kind: response?.kind ?? null,
          },
          'payout_landing_attempt_unusable',
        );
        return;
      }
      // ③
      const landingRow = {
        id: row.id,
        app_id: row.app_id,
        user_id: row.user_id,
        row_version: row.row_version,
        amount_fen: row.amount_fen,
        net_fen: row.net_fen,
        fee_fen: row.fee_fen,
        tax_fen: row.tax_fen,
        out_biz_no: row.out_biz_no,
        payout_channel: row.payout_channel,
      };
      if (response.kind === 'success') {
        // paid_at: the channel's time, else the moment the payout process received the result
        // (response.received_at), else the attempt row's `at`.
        const receivedMs = instantMs(response.receivedAt) ?? attempt.at.getTime();
        const landed = await landing.success(
          landingRow,
          {
            raw: response.raw,
            ...(response.channelOrderId === undefined
              ? {}
              : { channelOrderId: response.channelOrderId }),
            ...(response.paidAt === undefined ? {} : { paidAt: response.paidAt }),
          },
          instant(now, receivedMs),
          trx,
        );
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, attempt_id: attempt.id, landed },
          'payout_landing_success',
        );
      } else {
        const failCode = attempt.resp_sub_code ?? response.status ?? attempt.resp_code ?? undefined;
        const landed = await landing.fail(
          landingRow,
          { raw: response.raw, ...(failCode === undefined ? {} : { failCode }) },
          now,
          trx,
        );
        logger.info(
          {
            withdrawal_id: row.id,
            out_biz_no: row.out_biz_no,
            attempt_id: attempt.id,
            fail_code: failCode ?? null,
            landed,
          },
          'payout_landing_fail',
        );
      }
    });
  };
}

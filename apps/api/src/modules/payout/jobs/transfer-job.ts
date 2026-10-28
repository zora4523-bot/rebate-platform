// B2-06d / B2-06f: the transfer job of the payout process (规划/08 BR-WDR-13 ①–⑤, BR-WDR-14,
// BR-WDR-17, BR-WDR-28, BR-WDR-09; state machine W5 / W6 / W9; 规划/12 §5.4). createTransferJob(options)
// is the handler of queue `payout`, job names `transfer` (payload TransferJobPayload, enqueued by
// EXECUTE) and `release` (the same payload, enqueued by the worker's review; B2-06f registers both;
// the queue works it with concurrency 1). The process connects as couli_payout only (D10-326): it
// never reads users or account_balances and never writes config_items (D10-398).
// `transfer`:
//   ① read the withdrawal (app_id and id of the payload, row lock). Missing, status ≠ PAYING or
//      execute_seq ≠ the payload's → resolve; nothing written, no channel call, no query.
//   ② any kind=transfer attempt of the withdrawal (whatever its result) → no transfer; enqueue the
//      first query job (below) and resolve. The attempt row is left as it is. B2-06g: an attempt
//      recorded as payer_side (response kind) whose W9 did not commit → that W9 on this
//      transaction instead of the query; the pause and the alert are not repeated (they were done
//      when the result was judged, below). B2-06h: an attempt still pending whose payer-side
//      result this process judged (the in-process record below) → its completion with that result
//      and the W9 on this transaction, likewise instead of the query. A pending attempt this process
//      never judged as payer-side (an ordinary unknown, an unknown_code pause, a crash between ④ and
//      the completion) still gets the first query.
//   ③ (D10-398 ①) the review of payout_disabled → queue_paused → channel_disabled → member_blocked
//      runs on the worker (jobs/review-job.ts, couli_app, under the users lock): on the same
//      transaction one job
//        queue.send('payout-review', 'review', { app_id, withdrawal_id, execute_seq },
//          { trx, singletonKey: `${withdrawal_id}:${execute_seq}:review` })
//      No switch is read here. The worker does W9 itself or sends `release` back.
// `release`:
//   ① and ② again, then ③ inside pg_advisory_xact_lock(hashtext('payout_daily:' || app_id)) the
//      re-check of application/payout-review.ts: payout_disabled / queue_paused / channel_disabled
//      read from PG through `config` (queue_paused also true while this process holds an
//      unpersisted pause of the app, below), member_blocked only as the row's own blocked_reason
//      (users and balances stay the worker's), single_cap / daily_cap. A failing check → W9 on that
//      transaction (application/transfer-gates.ts); member_blocked also enqueues one negative
//      balance recheck on the same transaction:
//        queue.send('evt.payout-went-negative', 'account.went_negative', { app_id, user_id }, { trx })
//      No attempt, no voucher, no channel call.
//   ④ still inside the lock: insert payout_attempts (kind transfer, result pending, request = a
//      masked summary without the payee's account or name, at = Clock.now) and commit it, so the
//      row is visible to any other connection before ⑤ and the lock is released before ⑤.
//   ⑤ outside any transaction: channels[payout_channel].transfer({ outBizNo: out_biz_no, netFen:
//      net_fen, payee: { identity: decryptPayee(payee_account_cipher, payout_method), name:
//      payee_name }, channel }) (the 10-second timeout lives in the channel). A rejection of any
//      kind (timeout, network) is an unknown result; the handler never rethrows it and never calls
//      transfer again (the job resolves, so the queue does not retry).
// Residual window (D10-398 ③): a member blocked between the worker's review commit and this
// release (one queue round trip) is not seen by the release unless the block is the row's own
// blocked_reason; the release cannot read users or balances as couli_payout.
// Landing the synchronous result: the pending attempt row is completed once (response, resp_code,
// resp_sub_code, result, latency_ms). B2-06fz (D10-326 C): this process cannot post vouchers, so a
// success / fail is handed to the worker as one payout-landing job on the attempt's transaction
// (application/landing-handoff.ts; the worker's jobs/landing-job.ts does W5 / W6) unless the
// withdrawal changed meanwhile (then only a warn, W10 ends it):
//   success     W5 CHANNEL_SUCCESS → PAID_API (worker).
//   fail        W6 CHANNEL_FAIL → FAILED (worker).
//   payer_side  W9 → APPROVED with hold_reason payer_side_after_transfer (no refund, frozen stays)
//               with the attempt's completion (fail) on one transaction of this process; no query.
//               B2-06h: that transaction is tried once more on a fresh one before rejecting.
//   unknown     stays PAYING; attempt unknown; the first query job (below).
// B2-06g: a payer_side result, or an unknown one with pauseQueue (a code outside the three lists),
// pauses first: as soon as the result is judged, before the attempt is completed, the W9 or the
// first query, the in-process mark is set, the alert is raised and the pause job is sent (below).
// None of it is undone when a later step throws. B2-06h: a judged payer-side result is also kept in
// process (withdrawal, execute_seq, attempt, the channel's answer) until its W9 commits, so a
// failed completion / W9 (both tried twice) rejects and the release redelivered to this process
// completes the attempt with the channel's code and lands the W9 at ②; a failed first query send is tried
// once more on a fresh transaction before rejecting (② then sends it).
// The pause (D10-398 ②): this process cannot write payout.queue_paused, so it pauses the app in
// process at once (every later release of the app is W9 queue_paused) and sends
//   queue.send('payout-landing', 'pause', { app_id, reason }, { trx: null, singletonKey })
// for the worker (jobs/pause-job.ts) to persist through content's system write. Never on the W9's
// transaction; a failed send is logged and stops nothing that follows. The mark keeps the
// config version of payout.queue_paused the release read under the payout_daily lock (0 without a
// row, D10-404 ②); once a later release reads a higher version under that lock (the worker's
// persisted pause or an admin's release, true or false) the mark is dropped and PG rules. The
// version unchanged (another key's version does not count), the mark holds. A failed pause send
// keeps the mark and alerts payout_pause_send_failed; recovery is manual (D10-404 ③): set
// payout.queue_paused in the admin and release it again, the version moves on and the mark goes.
// No automatic resend (follow-up). A new process starts with none (PG rules).
// The first query job (BR-WDR-14; consumed by B2-06e), on the transaction of that step:
//   queue.send('payout', 'query', { withdrawal_id, execute_seq, app_id, point: 0 },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:query:0`,
//       delaySeconds: payout.query_schedule.points_min[0] × 60 })
// Every transition goes through the generated transitionWithdrawal() with a CAS on status and
// row_version; 0 rows → logger.warn, nothing else written for it, no retry, no throw. Database
// errors before ⑤ may reject (a redelivery is then stopped by ① / ②), and after ⑤ only as above.
// Alert: logger.warn(fields, 'payout_queue_paused') with withdrawal_id, out_biz_no, code, sub_code
// and cause ('payer_side' | 'unknown_code'). Logs carry withdrawal_id, out_biz_no, code, sub_code,
// hold_reason, latency_ms only — never the payee's account or name.
//
// Database roles: `db` and `attemptsDb` are the process handle (couli_payout: withdrawals W9
// columns, payout_attempts, event_log, pgboss, config_items SELECT). A row lock the transaction
// holds on the withdrawal must not block the attempt insert's foreign key check (FOR NO KEY
// UPDATE, not FOR UPDATE).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Clock, EventBus, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { Logger } from 'pino';
import type { ChannelRaw, TransferResult } from '../domain/channel-result.ts';
import { readPayoutChannelConfig } from '../application/judgement.ts';
import { instant } from '../application/payout-landing.ts';
import { handoffLanding, recordedResponse } from '../application/landing-handoff.ts';
import { reviewTransfer } from '../application/payout-review.ts';
import {
  SWITCH_DEFAULTS,
  channelSwitchesOpen,
  holdWithdrawal,
  isChannel,
  readSwitch,
} from '../application/transfer-gates.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { DecryptWithdrawalAccount } from '../application/withdrawal-reads.ts';
import { maskLogonId } from '../infra/channels/alipay-channel.ts';
import type {
  ChannelJudgement,
  PayoutChannel,
  PayoutChannelName,
} from '../infra/channels/payout-channel.ts';
import { createPayoutAttemptsStore } from '../infra/payout-attempts-store.ts';

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

/** content's system write of payout.queue_paused = true, on the caller's transaction (worker). */
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
  /** The process handle (couli_payout): withdrawals, W9, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  /** couli_payout handle: the only writer of payout_attempts. */
  readonly attemptsDb: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.* switches, caps and query_schedule), direct PG. */
  readonly config: PayoutConfigPort;
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /** One adapter per opened channel (B2-06b); FakeChannel outside prod. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
  /** The process's field cipher: the payee account of the withdrawal's snapshot. */
  readonly decryptPayee: DecryptWithdrawalAccount;
  readonly logger: TransferJobLogger;
}

/** Queue and job name of the first query (BR-WDR-14), and of the negative balance recheck. */
export const PAYOUT_QUEUE = 'payout';
export const PAYOUT_QUERY_JOB = 'query';
/** EXECUTE's job and the worker's release on queue `payout` (D10-398 ①). */
export const PAYOUT_TRANSFER_JOB = 'transfer';
export const PAYOUT_RELEASE_JOB = 'release';
/** The worker's review queue and job (D10-398 ①). */
export const PAYOUT_REVIEW_QUEUE = 'payout-review';
export const PAYOUT_REVIEW_JOB = 'review';
/** The worker's pause job on payout-landing (D10-398 ②). */
export const PAYOUT_PAUSE_QUEUE = 'payout-landing';
export const PAYOUT_PAUSE_JOB = 'pause';
export const PAYOUT_WENT_NEGATIVE_QUEUE = 'evt.payout-went-negative';
export const PAYOUT_WENT_NEGATIVE_JOB = 'account.went_negative';
export const PAYOUT_QUEUE_PAUSED_ALERT: TransferAlertMessage = 'payout_queue_paused';

const PAYING = 'PAYING';
const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
const SENT_RESULTS = ['pending', 'success', 'unknown'] as const;

interface WithdrawalRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly execute_seq: number;
  readonly row_version: number;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly out_biz_no: string;
  readonly payout_channel: string;
  readonly payout_method: string;
  readonly payee_name: string;
  readonly payee_account_cipher: Buffer;
  readonly blocked_reason: string | null;
}

/** The payload of `transfer`, `review` and `release` (null when malformed). */
export function parseTransferPayload(job: ReceivedJob): TransferJobPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const withdrawalId = payload['withdrawal_id'];
  const executeSeq = payload['execute_seq'];
  const appId = payload['app_id'];
  if (
    typeof withdrawalId !== 'string' ||
    withdrawalId === '' ||
    typeof appId !== 'string' ||
    appId === '' ||
    typeof executeSeq !== 'number' ||
    !Number.isInteger(executeSeq)
  ) {
    return null;
  }
  return { withdrawal_id: withdrawalId, execute_seq: executeSeq, app_id: appId };
}

/** The payee's name reduced to its first character (the attempt's masked request summary). */
function maskName(name: string): string {
  const first = [...name][0];
  return first === undefined ? '' : `${first}**`;
}

interface JudgedPayerSide {
  readonly attemptId: string;
  readonly result: TransferResult;
  readonly receivedAt: Date;
}

function judgedKey(row: Pick<WithdrawalRow, 'id' | 'execute_seq'>): string {
  return `${row.id}:${row.execute_seq}`;
}

type Outcome =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'send';
      readonly row: WithdrawalRow;
      readonly channel: PayoutChannelName;
      readonly adapter: PayoutChannel;
      readonly attemptId: string;
      readonly identity: string;
      readonly firstQueryDelaySeconds: number;
      /** payout.queue_paused's config version read in ③ under the payout_daily lock (D10-404 ②). */
      readonly queuePausedVersion: number;
      /** The app's judgement lists and payout.biz_scene, read in ③ (BR-WDR-17 / BR-WDR-28). */
      readonly judgement: ChannelJudgement;
    };

export function createTransferJob(options: TransferJobOptions): JobHandler {
  const { db, attemptsDb, clock, config, queue, eventBus, channels, decryptPayee, logger } =
    options;
  const attempts = createPayoutAttemptsStore();
  /** readPayoutChannelConfig wants pino's warn; the job's logger has the same two-argument shape. */
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;
  /**
   * Apps this process paused, with the payout.queue_paused config version read under the
   * payout_daily lock when pausing (0 without a row): fail closed until a release reads a higher
   * version (D10-404 ②: the worker persisted the pause or an admin released it).
   */
  const unpersistedPauses = new Map<string, number>();
  /**
   * B2-06h: payer-side results this process judged whose completion and W9 have not committed,
   * by `${withdrawal_id}:${execute_seq}` (dropped once ① sees the withdrawal left PAYING). A new
   * process starts with none: its redelivery then only sees a pending attempt and queries.
   */
  const judgedPayerSide = new Map<string, JudgedPayerSide>();

  async function readRow(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<WithdrawalRow | null> {
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
        'amount_fen',
        'net_fen',
        'fee_fen',
        'tax_fen',
        'out_biz_no',
        'payout_channel',
        'payout_method',
        'payee_name',
        'payee_account_cipher',
        'blocked_reason',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', withdrawalId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  async function firstQueryDelaySeconds(trx: Transaction<DB>, appId: string): Promise<number> {
    const channelConfig = await readPayoutChannelConfig(appId, trx, config, configLogger);
    const minutes = channelConfig.querySchedule.points_min[0] ?? 1;
    return minutes * 60;
  }

  async function sendFirstQuery(
    trx: Transaction<DB>,
    row: Pick<WithdrawalRow, 'id' | 'app_id' | 'execute_seq'>,
    delaySeconds: number,
  ): Promise<void> {
    const payload: QueryJobPayload = {
      withdrawal_id: row.id,
      execute_seq: row.execute_seq,
      app_id: row.app_id,
      point: 0,
    };
    await queue.send(
      PAYOUT_QUEUE,
      PAYOUT_QUERY_JOB,
      { ...payload },
      {
        trx,
        singletonKey: `${row.id}:${row.execute_seq}:query:0`,
        delaySeconds,
      },
    );
  }

  /** Σ net_fen of today's (+08:00) transfer attempts of the app still counted as sent. */
  async function dailySentFen(trx: Transaction<DB>, appId: string, now: Date): Promise<bigint> {
    const day = chinaDayRange(accountingDate(now));
    const from = instant(now, Date.parse(day.start));
    const to = instant(now, Date.parse(day.end));
    const row = await trx
      .withSchema('app')
      .selectFrom('payout_attempts as a')
      .innerJoin('withdrawals as w', (join) =>
        join.onRef('w.id', '=', 'a.withdrawal_id').onRef('w.app_id', '=', 'a.app_id'),
      )
      .select(sql<string | null>`sum(w.net_fen)::text`.as('total'))
      .where('a.app_id', '=', appId)
      .where('a.kind', '=', 'transfer')
      .where('a.result', 'in', [...SENT_RESULTS])
      .where('a.at', '>=', from)
      .where('a.at', '<', to)
      .executeTakeFirst();
    const total = row?.total ?? null;
    return total === null ? 0n : parseFen(total);
  }

  function alert(row: WithdrawalRow, raw: ChannelRaw | null, cause: TransferAlertCause): void {
    logger.warn(
      {
        withdrawal_id: row.id,
        out_biz_no: row.out_biz_no,
        code: raw?.code ?? null,
        sub_code: raw?.subCode ?? null,
        cause,
      },
      PAYOUT_QUEUE_PAUSED_ALERT,
    );
  }

  /** A transfer attempt of the withdrawal completed with a payer_side result (response kind). */
  async function payerSideRecorded(
    trx: Transaction<DB>,
    row: Pick<WithdrawalRow, 'id' | 'app_id'>,
  ): Promise<boolean> {
    const found = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select('id')
      .where('app_id', '=', row.app_id)
      .where('withdrawal_id', '=', row.id)
      .where('kind', '=', 'transfer')
      .where('result', '=', 'fail')
      .where(sql<string | null>`response->>'kind'`, '=', 'payer_side')
      .limit(1)
      .executeTakeFirst();
    return found !== undefined;
  }

  /**
   * ① and ② on `trx`: the PAYING row of the payload, or null when the job ends here (skipped, or
   * already attempted: then the first query job is enqueued on `trx`).
   */
  async function admit(
    trx: Transaction<DB>,
    payload: TransferJobPayload,
    now: Date,
  ): Promise<WithdrawalRow | null> {
    // ①
    const row = await readRow(trx, payload.app_id, payload.withdrawal_id);
    if (row === null || row.status !== PAYING || row.execute_seq !== payload.execute_seq) {
      judgedPayerSide.delete(`${payload.withdrawal_id}:${payload.execute_seq}`);
      logger.info(
        {
          withdrawal_id: payload.withdrawal_id,
          execute_seq: payload.execute_seq,
          status: row?.status ?? null,
        },
        'payout_transfer_skipped',
      );
      return null;
    }
    // ②
    if (await attempts.hasTransfer(trx, { appId: row.app_id, withdrawalId: row.id })) {
      const judged = judgedPayerSide.get(judgedKey(row));
      if (judged !== undefined || (await payerSideRecorded(trx, row))) {
        // B2-06g: the W9 of a judged payer-side result did not commit; land it now (paused and
        // alerted already when it was judged). B2-06h: judged by this process but its completion
        // did not commit either → complete the pending attempt with the channel's answer first.
        if (judged !== undefined) {
          await completeAttempt(trx, judged.attemptId, judged.result, 'fail', judged.receivedAt);
        }
        await holdWithdrawal(trx, { eventBus, logger }, row, 'payer_side_after_transfer', now);
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, hold_reason: PAYER_SIDE_HOLD },
          'payout_transfer_held',
        );
        return null;
      }
      await sendFirstQuery(trx, row, await firstQueryDelaySeconds(trx, row.app_id));
      logger.info(
        { withdrawal_id: row.id, out_biz_no: row.out_biz_no },
        'payout_transfer_already_attempted',
      );
      return null;
    }
    return row;
  }

  /** `transfer`: ① ② and the worker's review job on one transaction (D10-398 ①). */
  async function requestReview(payload: TransferJobPayload): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const row = await admit(trx, payload, clock.now());
      if (row === null) return;
      await queue.send(
        PAYOUT_REVIEW_QUEUE,
        PAYOUT_REVIEW_JOB,
        { app_id: row.app_id, withdrawal_id: row.id, execute_seq: row.execute_seq },
        { trx, singletonKey: `${row.id}:${row.execute_seq}:review` },
      );
      logger.info(
        { withdrawal_id: row.id, out_biz_no: row.out_biz_no },
        'payout_transfer_review_requested',
      );
    });
  }

  /**
   * payout.queue_paused of PG, or true while this process holds an unpersisted pause, with the
   * key's config version (0 without a row). A version above the mark's drops the mark first.
   */
  async function queuePaused(
    trx: Transaction<DB>,
    appId: string,
  ): Promise<{ readonly paused: boolean; readonly version: number }> {
    const version = (await config.configValue(appId, 'payout.queue_paused', trx))?.version ?? 0;
    const mark = unpersistedPauses.get(appId);
    if (mark !== undefined && version > mark) unpersistedPauses.delete(appId);
    const persisted = await readSwitch(
      config,
      logger,
      trx,
      appId,
      'payout.queue_paused',
      SWITCH_DEFAULTS.queuePaused,
    );
    return { paused: persisted || unpersistedPauses.has(appId), version };
  }

  /** `release`: ① ②, ③ re-check and ④ on one transaction (the daily lock is held from ③ to its end). */
  async function prepare(payload: TransferJobPayload, now: Date): Promise<Outcome> {
    return db.transaction().execute(async (trx): Promise<Outcome> => {
      const row = await admit(trx, payload, now);
      if (row === null) return { kind: 'done' };
      // ③
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`payout_daily:${row.app_id}`}))`.execute(
        trx,
      );
      const payoutEnabled = await readSwitch(
        config,
        logger,
        trx,
        row.app_id,
        'payout.enabled',
        SWITCH_DEFAULTS.enabled,
      );
      const { paused, version: queuePausedVersion } = await queuePaused(trx, row.app_id);
      const channel = isChannel(row.payout_channel) ? row.payout_channel : null;
      const adapter = channel === null ? undefined : channels[channel];
      const channelOpen =
        channel !== null &&
        adapter !== undefined &&
        (await channelSwitchesOpen(config, logger, trx, row.app_id, channel));
      const channelConfig = await readPayoutChannelConfig(row.app_id, trx, config, configLogger);
      const verdict = reviewTransfer({
        payoutEnabled,
        queuePaused: paused,
        channelOpen,
        // The worker reviewed users / balances / risk / appeal / holds; the release only sees the
        // row's own block (D10-398 ③: couli_payout reads no users or balances).
        memberBlocked: row.blocked_reason !== null,
        netFen: row.net_fen,
        singleCapFen: BigInt(channelConfig.singleCapFen),
        dailySentFen: await dailySentFen(trx, row.app_id, now),
        dailyCapFen: BigInt(channelConfig.dailyCapFen),
      });
      if (!verdict.ok) {
        const held = await holdWithdrawal(trx, { eventBus, logger }, row, verdict.reason, now);
        if (held && verdict.reason === 'member_blocked') {
          await queue.send(
            PAYOUT_WENT_NEGATIVE_QUEUE,
            PAYOUT_WENT_NEGATIVE_JOB,
            { app_id: row.app_id, user_id: row.user_id },
            { trx },
          );
        }
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, hold_reason: verdict.reason },
          'payout_transfer_held',
        );
        return { kind: 'done' };
      }
      // ④ (channel and adapter are set: channelOpen held)
      const identity = decryptPayee(row.payee_account_cipher, row.payout_method);
      const attemptId = randomUUID();
      await attemptsDb
        .withSchema('app')
        .insertInto('payout_attempts')
        .values({
          id: attemptId,
          app_id: row.app_id,
          withdrawal_id: row.id,
          kind: 'transfer',
          request: JSON.stringify({
            out_biz_no: row.out_biz_no,
            channel,
            net_fen: row.net_fen.toString(),
            payee: { identity: maskLogonId(identity), name: maskName(row.payee_name) },
          }),
          result: 'pending',
          at: now,
        })
        .execute();
      return {
        kind: 'send',
        row,
        channel: channel as PayoutChannelName,
        adapter: adapter as PayoutChannel,
        attemptId,
        identity,
        firstQueryDelaySeconds: (channelConfig.querySchedule.points_min[0] ?? 1) * 60,
        queuePausedVersion,
        judgement: {
          lists: {
            definiteFailCodes: channelConfig.definiteFailCodes,
            payerSideCodes: channelConfig.payerSideCodes,
            queryStatusMap: channelConfig.queryStatusMap,
          },
          bizScene: channelConfig.bizScene,
        },
      };
    });
  }

  async function completeAttempt(
    executor: Kysely<DB> | Transaction<DB>,
    attemptId: string,
    result: TransferResult | null,
    stored: 'success' | 'fail' | 'unknown',
    receivedAt: Date,
  ): Promise<void> {
    await executor
      .withSchema('app')
      .updateTable('payout_attempts')
      .set({
        response: JSON.stringify(
          result === null
            ? { transport_error: true, received_at: receivedAt.toISOString() }
            : recordedResponse(result, receivedAt),
        ),
        resp_code: result?.raw.code ?? null,
        resp_sub_code: result?.raw.subCode ?? null,
        result: stored,
        latency_ms: result === null ? null : Math.max(0, Math.round(result.latencyMs)),
      })
      .where('id', '=', attemptId)
      .where('result', '=', 'pending')
      .execute();
  }

  /**
   * A success / fail: the attempt is completed and, when the withdrawal is unchanged, the landing
   * job is sent to the worker on the same couli_payout transaction (D10-326 C, D10-332 ①).
   */
  async function recordAndHandoff(
    row: WithdrawalRow,
    attemptId: string,
    result: TransferResult,
    receivedAt: Date,
  ): Promise<void> {
    await attemptsDb.transaction().execute(async (trx) => {
      await completeAttempt(
        trx,
        attemptId,
        result,
        result.kind === 'success' ? 'success' : 'fail',
        receivedAt,
      );
      await handoffLanding({ trx, queue, row, attemptId, logger });
    });
  }

  /**
   * D10-398 ② / B2-06g: the app is paused in this process and alerted at once, then the worker is
   * asked to persist the pause (its own send, never a transaction of the landing). The mark keeps
   * `version`, payout.queue_paused's config version read in ③ under the lock. A failed send is
   * logged, not rethrown: the mark holds until the version moves on (D10-404 ③: an admin sets
   * payout.queue_paused and releases it) or the process ends. Nothing here is undone by a later
   * failure of the W9 or the first query.
   */
  async function pauseAndAlert(
    row: WithdrawalRow,
    raw: ChannelRaw,
    cause: TransferAlertCause,
    version: number,
  ): Promise<void> {
    unpersistedPauses.set(row.app_id, version);
    alert(row, raw, cause);
    try {
      await queue.send(
        PAYOUT_PAUSE_QUEUE,
        PAYOUT_PAUSE_JOB,
        { app_id: row.app_id, reason: cause },
        { trx: null, singletonKey: `${row.app_id}:pause:${cause}` },
      );
    } catch (error: unknown) {
      logger.warn(
        {
          app_id: row.app_id,
          withdrawal_id: row.id,
          cause,
          error: error instanceof Error ? error.name : 'unknown',
          recovery:
            'paused in this process only; set payout.queue_paused in the admin and release it (its version moves on and the pause ends)',
        },
        'payout_pause_send_failed',
      );
    }
  }

  /**
   * The attempt's completion (fail, the channel's answer) and W9 payer_side_after_transfer on one
   * transaction of this process (paused and alerted before); a failed one is tried once more on a
   * fresh transaction, then rethrown (the in-process record stays for the redelivery's ②).
   */
  async function landPayerSide(
    row: WithdrawalRow,
    judged: JudgedPayerSide,
    now: Date,
  ): Promise<void> {
    const land = () =>
      db.transaction().execute(async (trx) => {
        await completeAttempt(trx, judged.attemptId, judged.result, 'fail', judged.receivedAt);
        await holdWithdrawal(trx, { eventBus, logger }, row, PAYER_SIDE_HOLD, now);
      });
    try {
      await land();
    } catch (error: unknown) {
      logger.warn(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'payout_transfer_landing_retried',
      );
      await land();
    }
    judgedPayerSide.delete(judgedKey(row));
  }

  async function landUnknown(row: WithdrawalRow, delaySeconds: number): Promise<void> {
    await db.transaction().execute((trx) => sendFirstQuery(trx, row, delaySeconds));
  }

  async function release(payload: TransferJobPayload): Promise<void> {
    const now = clock.now();
    const outcome = await prepare(payload, now);
    if (outcome.kind !== 'send') return;
    const {
      row,
      channel,
      adapter,
      attemptId,
      identity,
      firstQueryDelaySeconds: delay,
      queuePausedVersion,
      judgement,
    } = outcome;

    // ⑤ outside any transaction; never rethrown, never retried.
    let result: TransferResult | null = null;
    try {
      result = await adapter.transfer(
        {
          outBizNo: row.out_biz_no,
          netFen: row.net_fen,
          payee: { identity, name: row.payee_name },
          channel,
        },
        judgement,
      );
    } catch (error: unknown) {
      logger.warn(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'payout_transfer_transport_error',
      );
      result = null;
    }

    const landedAt = clock.now();
    // B2-06g: pause and alert as soon as the result is judged, before anything below can fail.
    if (result !== null && result.kind === 'payer_side') {
      judgedPayerSide.set(judgedKey(row), { attemptId, result, receivedAt: landedAt });
      await pauseAndAlert(row, result.raw, 'payer_side', queuePausedVersion);
    } else if (result !== null && result.kind === 'unknown' && result.pauseQueue === true) {
      await pauseAndAlert(row, result.raw, 'unknown_code', queuePausedVersion);
    }
    try {
      const stored =
        result === null
          ? 'unknown'
          : result.kind === 'success'
            ? 'success'
            : result.kind === 'unknown'
              ? 'unknown'
              : 'fail';
      if (result !== null && (result.kind === 'success' || result.kind === 'fail')) {
        await recordAndHandoff(row, attemptId, result, landedAt);
      } else if (result === null || result.kind === 'unknown') {
        await completeAttempt(attemptsDb, attemptId, result, stored, landedAt);
      }
      // payer_side: completed together with its W9 below (landPayerSide).
      logger.info(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          code: result?.raw.code ?? null,
          sub_code: result?.raw.subCode ?? null,
          result: result?.kind ?? 'unknown',
          latency_ms: result?.latencyMs ?? null,
        },
        'payout_transfer_result',
      );
      if (result === null || result.kind === 'unknown') {
        await landUnknown(row, delay);
      } else if (result.kind === 'payer_side') {
        await landPayerSide(row, { attemptId, result, receivedAt: landedAt }, landedAt);
      }
      // success / fail: recorded and handed to the worker above (jobs/landing-job.ts lands W5 / W6).
    } catch (error: unknown) {
      // A database error while landing the result: the transfer is recorded, so a redelivery is
      // stopped at ②. A payer-side result rejects (after landPayerSide's second try): no query, the
      // redelivery to this process completes the attempt and lands its W9 at ② (paused, alerted and
      // recorded in process above, kept). Otherwise try to leave the first query job; if even
      // that fails, reject so the queue redelivers (② then enqueues the query).
      logger.warn(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'payout_transfer_landing_failed',
      );
      if (result !== null && result.kind === 'payer_side') throw error;
      await db.transaction().execute((trx) => sendFirstQuery(trx, row, delay));
    }
  }

  return async function transferJob(job: ReceivedJob): Promise<void> {
    const payload = parseTransferPayload(job);
    if (payload === null) {
      logger.warn(
        { job_id: job.id, queue: job.queue, name: job.name },
        'payout_transfer_bad_payload',
      );
      return;
    }
    if (job.name === PAYOUT_RELEASE_JOB) return release(payload);
    return requestReview(payload);
  };
}

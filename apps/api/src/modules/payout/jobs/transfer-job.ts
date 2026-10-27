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
// Landing the synchronous result: the pending attempt row is completed once (response, resp_code,
// resp_sub_code, result, latency_ms). B2-06fz (D10-326 C): this process connects as couli_payout
// and cannot post vouchers, so a success / fail is handed to the worker as one payout-landing job
// on the attempt's transaction (application/landing-handoff.ts; the worker's jobs/landing-job.ts
// does W5 / W6 below) unless the withdrawal changed meanwhile (then only a warn, W10 ends it):
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
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  accountingDate,
  chinaDayRange,
  transitionWithdrawal,
  type WithdrawalState,
} from '@couli/domain';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { Logger } from 'pino';
import type { ChannelRaw, TransferResult } from '../domain/channel-result.ts';
import { readPayoutChannelConfig } from '../application/judgement.ts';
import { instant } from '../application/payout-landing.ts';
import { handoffLanding, recordedResponse } from '../application/landing-handoff.ts';
import { reviewTransfer, type TransferHoldReason } from '../application/payout-review.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { DecryptWithdrawalAccount } from '../application/withdrawal-reads.ts';
import { maskLogonId } from '../infra/channels/alipay-channel.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';
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

/** Queue and job name of the first query (BR-WDR-14), and of the negative balance recheck. */
export const PAYOUT_QUEUE = 'payout';
export const PAYOUT_QUERY_JOB = 'query';
export const PAYOUT_WENT_NEGATIVE_QUEUE = 'evt.payout-went-negative';
export const PAYOUT_WENT_NEGATIVE_JOB = 'account.went_negative';
export const PAYOUT_QUEUE_PAUSED_ALERT: TransferAlertMessage = 'payout_queue_paused';
const PAUSE_SOURCE = 'payout_transfer';

/** Switch defaults when a key is absent or unreadable (content's switch registry, BR-WDR-32 / 33). */
const SWITCH_DEFAULTS = {
  enabled: true,
  queuePaused: false,
  channelEnabled: { alipay: true, bank_card: false, wechat: false } as const,
  channelPaused: false,
} as const;

const CHANNELS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);
const PAYING: WithdrawalState = 'PAYING';
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

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseSwitch(value: unknown): Parsed<boolean> {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'on' || value === 'true') return { ok: true, value: true };
  if (value === 'off' || value === 'false') return { ok: true, value: false };
  return { ok: false };
}

function parsePayload(job: ReceivedJob): TransferJobPayload | null {
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

function isChannel(value: string): value is PayoutChannelName {
  return CHANNELS.has(value);
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
    };

export function createTransferJob(options: TransferJobOptions): JobHandler {
  const {
    db,
    attemptsDb,
    clock,
    config,
    risk,
    appeal,
    ledger,
    lockUsersForUpdate,
    queue,
    eventBus,
    channels,
    decryptPayee,
    pauseQueue,
    logger,
  } = options;
  const attempts = createPayoutAttemptsStore();
  /** readPayoutChannelConfig wants pino's warn; the job's logger has the same two-argument shape. */
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;

  async function setting(
    trx: Transaction<DB>,
    appId: string,
    key: string,
    fallback: boolean,
  ): Promise<boolean> {
    const row = await config.configValue(appId, key, trx);
    if (row === null) return fallback;
    const parsed = parseSwitch(row.value);
    if (parsed.ok) return parsed.value;
    logger.warn({ app_id: appId, config_key: key }, 'payout_config_default');
    return fallback;
  }

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

  /** BR-WDR-05: the member's withdrawal block, under the users → balances locks of `trx`. */
  async function memberBlocked(
    trx: Transaction<DB>,
    row: WithdrawalRow,
    now: Date,
  ): Promise<boolean> {
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

  /** W9 by CAS on (status PAYING, row_version); false when the row moved meanwhile. */
  async function hold(
    trx: Transaction<DB>,
    row: WithdrawalRow,
    reason: TransferHoldReason | 'payer_side_after_transfer',
    now: Date,
  ): Promise<boolean> {
    const transition = transitionWithdrawal(PAYING, 'HOLD');
    if (!transition.ok || transition.noop) return false;
    const result = await trx
      .withSchema('app')
      .updateTable('withdrawals')
      .set({
        status: transition.to,
        hold_reason: reason,
        hold_at: now,
        executor_id: null,
        executed_at: null,
        row_version: row.row_version + 1,
        updated_at: now,
      })
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.id)
      .where('status', '=', PAYING)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      logger.warn(
        { withdrawal_id: row.id, out_biz_no: row.out_biz_no, hold_reason: reason },
        'payout_transfer_cas_conflict',
      );
      return false;
    }
    await eventBus.publish(trx, {
      appId: row.app_id,
      name: 'wallet.withdrawal_changed',
      payload: { withdrawal_id: row.id, user_id: row.user_id, status: transition.to },
    });
    return true;
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

  /** Steps ① to ④ on one business transaction (the daily lock is held from ③ to its end). */
  async function prepare(payload: TransferJobPayload, now: Date): Promise<Outcome> {
    return db.transaction().execute(async (trx): Promise<Outcome> => {
      // ①
      const row = await readRow(trx, payload.app_id, payload.withdrawal_id);
      if (row === null || row.status !== PAYING || row.execute_seq !== payload.execute_seq) {
        logger.info(
          {
            withdrawal_id: payload.withdrawal_id,
            execute_seq: payload.execute_seq,
            status: row?.status ?? null,
          },
          'payout_transfer_skipped',
        );
        return { kind: 'done' };
      }
      // ②
      if (await attempts.hasTransfer(trx, { appId: row.app_id, withdrawalId: row.id })) {
        await sendFirstQuery(trx, row, await firstQueryDelaySeconds(trx, row.app_id));
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no },
          'payout_transfer_already_attempted',
        );
        return { kind: 'done' };
      }
      // ③
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`payout_daily:${row.app_id}`}))`.execute(
        trx,
      );
      const payoutEnabled = await setting(
        trx,
        row.app_id,
        'payout.enabled',
        SWITCH_DEFAULTS.enabled,
      );
      const queuePaused = await setting(
        trx,
        row.app_id,
        'payout.queue_paused',
        SWITCH_DEFAULTS.queuePaused,
      );
      const channel = isChannel(row.payout_channel) ? row.payout_channel : null;
      const adapter = channel === null ? undefined : channels[channel];
      const channelOpen =
        channel !== null &&
        adapter !== undefined &&
        (await setting(
          trx,
          row.app_id,
          `payout.channel_enabled.${channel}`,
          SWITCH_DEFAULTS.channelEnabled[channel],
        )) &&
        !(await setting(
          trx,
          row.app_id,
          `payout.channel_paused.${channel}`,
          SWITCH_DEFAULTS.channelPaused,
        ));
      const blocked = await memberBlocked(trx, row, now);
      const channelConfig = await readPayoutChannelConfig(row.app_id, trx, config, configLogger);
      const verdict = reviewTransfer({
        payoutEnabled,
        queuePaused,
        channelOpen,
        memberBlocked: blocked,
        netFen: row.net_fen,
        singleCapFen: BigInt(channelConfig.singleCapFen),
        dailySentFen: await dailySentFen(trx, row.app_id, now),
        dailyCapFen: BigInt(channelConfig.dailyCapFen),
      });
      if (!verdict.ok) {
        const held = await hold(trx, row, verdict.reason, now);
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

  async function landPayerSide(
    row: WithdrawalRow,
    result: TransferResult,
    now: Date,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await hold(trx, row, 'payer_side_after_transfer', now);
      await pauseQueue.pause(trx, {
        appId: row.app_id,
        source: PAUSE_SOURCE,
        reason: 'payer_side',
      });
    });
    alert(row, result.raw, 'payer_side');
  }

  async function landUnknown(
    row: WithdrawalRow,
    result: TransferResult | null,
    delaySeconds: number,
  ): Promise<void> {
    const pause = result !== null && result.pauseQueue === true;
    await db.transaction().execute(async (trx) => {
      if (pause) {
        await pauseQueue.pause(trx, {
          appId: row.app_id,
          source: PAUSE_SOURCE,
          reason: 'unknown_code',
        });
      }
      await sendFirstQuery(trx, row, delaySeconds);
    });
    if (pause) alert(row, result.raw, 'unknown_code');
  }

  return async function transferJob(job: ReceivedJob): Promise<void> {
    const payload = parsePayload(job);
    if (payload === null) {
      logger.warn(
        { job_id: job.id, queue: job.queue, name: job.name },
        'payout_transfer_bad_payload',
      );
      return;
    }
    const now = clock.now();
    const outcome = await prepare(payload, now);
    if (outcome.kind !== 'send') return;
    const { row, channel, adapter, attemptId, identity, firstQueryDelaySeconds: delay } = outcome;

    // ⑤ outside any transaction; never rethrown, never retried.
    let result: TransferResult | null = null;
    try {
      result = await adapter.transfer({
        outBizNo: row.out_biz_no,
        netFen: row.net_fen,
        payee: { identity, name: row.payee_name },
        channel,
      });
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
      } else {
        await completeAttempt(attemptsDb, attemptId, result, stored, landedAt);
      }
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
        await landUnknown(row, result, delay);
      } else if (result.kind === 'payer_side') {
        await landPayerSide(row, result, landedAt);
      }
      // success / fail: recorded and handed to the worker above (jobs/landing-job.ts lands W5 / W6).
    } catch (error: unknown) {
      // A database error while landing the result: the transfer is recorded, so a redelivery is
      // stopped at ② and only queries. Try to leave the first query job; if even that fails,
      // reject so the queue redelivers (② then enqueues the query).
      logger.warn(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'payout_transfer_landing_failed',
      );
      await db.transaction().execute((trx) => sendFirstQuery(trx, row, delay));
    }
  };
}

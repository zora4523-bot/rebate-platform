// B2-06e: the query job of the payout process (规划/08 BR-WDR-14, BR-WDR-15, BR-WDR-17, BR-WDR-28;
// state machine W5 / W6). createQueryJob(options) is the handler of queue `payout`, job name
// `query`, payload QueryJobPayload { withdrawal_id, execute_seq, app_id, point } (B2-06d enqueues
// point 0; B2-06f registers the handler). Strict order:
//   ① read the withdrawal (app_id and id of the payload, row lock FOR NO KEY UPDATE). Missing,
//      status ≠ PAYING or execute_seq ≠ the payload's → resolve; nothing written, no query.
//   ② needs_manual = true → resolve: automatic queries have stopped (W10's "query now" is B2-09).
//   ③ T = `at` of the withdrawal's earliest kind=transfer attempt; none → warn and resolve.
//   ④ manualDue(schedule, T, now) → CAS needs_manual = true (row_version + 1, status and amounts
//      unchanged), logger.warn({ withdrawal_id, out_biz_no, point }, 'payout_needs_manual'), no
//      query, no job. needs_manual is granted to couli_payout only (db/schema.sql).
//   ⑤ otherwise channels[payout_channel].query(out_biz_no) at most 3 times, sleep(10 000) between
//      two tries (injected port; default the platform timers); each try writes one kind=query
//      payout_attempts row on attemptsDb (request { out_biz_no, point, try } with try 1, 2, 3,
//      the raw response, resp_code, resp_sub_code, result, latency_ms). success / fail stop the
//      tries. Timeouts, network errors, "order does not exist", processing and statuses outside
//      payout.query_status_map are unknown (the channel judges with the lists).
//   ⑥ success → W5 as in transfer-job.ts (CHANNEL_SUCCESS → PAID_API, channel_order_id, paid_at
//      the channel's time else Clock.now, WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID`, event);
//      fail → W6 (CHANNEL_FAIL → FAILED, fail_code = sub_code, WITHDRAW:RETURN, event); 3 times
//      unknown → stays PAYING and, on one transaction, the next point:
//        queue.send('payout', 'query', { …, point: n + 1 }, { trx,
//          singletonKey: `${withdrawal_id}:${execute_seq}:query:${n + 1}`,
//          delaySeconds: max(0, T + queryPointOffsetSeconds(n + 1) − now) })
//      A CAS that hits nothing (row_version moved) only warns. A query never pauses the queue.
// No transaction or lock is held across a channel call or a sleep (the ① read ends before ⑤).
// payout.enabled = off and payout.queue_paused = true do not stop queries (BR-WDR-17). Logs carry
// withdrawal_id, out_biz_no, point, code, sub_code only — never the payee's account or name.
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { QueryResult } from '../domain/channel-result.ts';
import { readPayoutChannelConfig } from '../application/judgement.ts';
import { createPayoutLanding } from '../application/payout-landing.ts';
import { markNeedsManual } from '../application/query-manual.ts';
import {
  manualDue,
  queryPointOffsetSeconds,
  type QuerySchedule,
} from '../application/query-schedule.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';
import { PAYOUT_QUERY_JOB, PAYOUT_QUEUE, type QueryJobPayload } from './transfer-job.ts';

export type { QueryJobPayload } from './transfer-job.ts';

/** The alert line when T + manual_after is reached (BR-WDR-14). */
export type QueryAlertMessage = 'payout_needs_manual';

/** Waits `ms` milliseconds (the gap between two tries of one point). */
export type QuerySleep = (ms: number) => Promise<void>;

export interface QueryJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface QueryJobOptions {
  /** Business handle: withdrawals, ledger, config, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  /** couli_payout handle: payout_attempts and withdrawals.needs_manual. */
  readonly attemptsDb: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.query_schedule, payout.query_status_map), direct PG. */
  readonly config: PayoutConfigPort;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /** One adapter per opened channel (B2-06b); FakeChannel outside prod. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
  /** Default: the platform timers. */
  readonly sleep?: QuerySleep;
  readonly logger: QueryJobLogger;
}

/** BR-WDR-14: at most this many tries per point, this many milliseconds apart. */
const MAX_TRIES = 3;
const RETRY_GAP_MS = 10_000;
const PAYING = 'PAYING';
const CHANNELS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);

interface QueryRow {
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

type Prepared =
  | { readonly kind: 'done' }
  | { readonly kind: 'manual'; readonly row: QueryRow }
  | {
      readonly kind: 'query';
      readonly row: QueryRow;
      readonly firstTransferAt: Date;
      readonly schedule: QuerySchedule;
    };

function parsePayload(job: ReceivedJob): QueryJobPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const withdrawalId = payload['withdrawal_id'];
  const executeSeq = payload['execute_seq'];
  const appId = payload['app_id'];
  const point = payload['point'];
  if (
    typeof withdrawalId !== 'string' ||
    withdrawalId === '' ||
    typeof appId !== 'string' ||
    appId === '' ||
    typeof executeSeq !== 'number' ||
    !Number.isInteger(executeSeq) ||
    typeof point !== 'number' ||
    !Number.isInteger(point) ||
    point < 0
  ) {
    return null;
  }
  return { withdrawal_id: withdrawalId, execute_seq: executeSeq, app_id: appId, point };
}

function isChannel(value: string): value is PayoutChannelName {
  return CHANNELS.has(value);
}

async function defaultSleep(ms: number): Promise<void> {
  await wait(ms);
}

export function createQueryJob(options: QueryJobOptions): JobHandler {
  const {
    db,
    attemptsDb,
    clock,
    config,
    ledger,
    lockUsersForUpdate,
    queue,
    eventBus,
    channels,
    logger,
  } = options;
  const sleep = options.sleep ?? defaultSleep;
  const landing = createPayoutLanding({
    db,
    ledger,
    lockUsersForUpdate,
    eventBus,
    logger,
    conflictMessage: 'payout_query_cas_conflict',
  });
  /** readPayoutChannelConfig wants pino's warn; the job's logger has the same two-argument shape. */
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;

  async function readRow(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<QueryRow | null> {
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
        'needs_manual',
        'amount_fen',
        'net_fen',
        'fee_fen',
        'tax_fen',
        'out_biz_no',
        'payout_channel',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', withdrawalId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  /** T: `at` of the withdrawal's earliest kind=transfer attempt (any result); null without one. */
  async function firstTransferAt(trx: Transaction<DB>, row: QueryRow): Promise<Date | null> {
    const first = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select((eb) => eb.fn.min('at').as('first_at'))
      .where('app_id', '=', row.app_id)
      .where('withdrawal_id', '=', row.id)
      .where('kind', '=', 'transfer')
      .executeTakeFirst();
    const at = first?.first_at ?? null;
    return at instanceof Date ? at : null;
  }

  /** ① to ④'s decision on one short business transaction (the row lock ends with it). */
  async function prepare(payload: QueryJobPayload, now: Date): Promise<Prepared> {
    return db.transaction().execute(async (trx): Promise<Prepared> => {
      const row = await readRow(trx, payload.app_id, payload.withdrawal_id);
      if (row === null || row.status !== PAYING || row.execute_seq !== payload.execute_seq) {
        logger.info(
          {
            withdrawal_id: payload.withdrawal_id,
            execute_seq: payload.execute_seq,
            point: payload.point,
            status: row?.status ?? null,
          },
          'payout_query_skipped',
        );
        return { kind: 'done' };
      }
      if (row.needs_manual) {
        logger.info(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point: payload.point },
          'payout_query_stopped_manual',
        );
        return { kind: 'done' };
      }
      const t = await firstTransferAt(trx, row);
      if (t === null) {
        logger.warn(
          { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point: payload.point },
          'payout_query_no_transfer',
        );
        return { kind: 'done' };
      }
      const { querySchedule } = await readPayoutChannelConfig(
        row.app_id,
        trx,
        config,
        configLogger,
      );
      if (manualDue(querySchedule, t, now)) return { kind: 'manual', row };
      return { kind: 'query', row, firstTransferAt: t, schedule: querySchedule };
    });
  }

  async function recordTry(
    row: QueryRow,
    point: number,
    tryNo: number,
    result: QueryResult | null,
    errorName: string | null,
    latencyMs: number,
    at: Date,
  ): Promise<void> {
    await attemptsDb
      .withSchema('app')
      .insertInto('payout_attempts')
      .values({
        id: randomUUID(),
        app_id: row.app_id,
        withdrawal_id: row.id,
        kind: 'query',
        request: JSON.stringify({ out_biz_no: row.out_biz_no, point, try: tryNo }),
        response: JSON.stringify(
          result === null
            ? { transport_error: true, error: errorName }
            : { raw: result.raw, kind: result.kind },
        ),
        resp_code: result?.raw.code ?? null,
        resp_sub_code: result?.raw.subCode ?? null,
        result: result?.kind ?? 'unknown',
        latency_ms: latencyMs,
        at,
      })
      .execute();
  }

  /** ⑤: up to MAX_TRIES queries, RETRY_GAP_MS apart; the first success / fail ends the point. */
  async function queryPoint(
    row: QueryRow,
    adapter: PayoutChannel,
    point: number,
  ): Promise<QueryResult | null> {
    let last: QueryResult | null = null;
    for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo += 1) {
      if (tryNo > 1) await sleep(RETRY_GAP_MS);
      const started = clock.now();
      let result: QueryResult | null = null;
      let errorName: string | null = null;
      try {
        result = await adapter.query(row.out_biz_no);
      } catch (error: unknown) {
        errorName = error instanceof Error ? error.name : 'unknown';
        logger.warn(
          {
            withdrawal_id: row.id,
            out_biz_no: row.out_biz_no,
            point,
            try: tryNo,
            error: errorName,
          },
          'payout_query_transport_error',
        );
      }
      const finished = clock.now();
      const latencyMs = Math.max(0, finished.getTime() - started.getTime());
      await recordTry(row, point, tryNo, result, errorName, latencyMs, finished);
      logger.info(
        {
          withdrawal_id: row.id,
          out_biz_no: row.out_biz_no,
          point,
          try: tryNo,
          code: result?.raw.code ?? null,
          sub_code: result?.raw.subCode ?? null,
          result: result?.kind ?? 'unknown',
          latency_ms: latencyMs,
        },
        'payout_query_result',
      );
      last = result;
      if (result !== null && result.kind !== 'unknown') return result;
    }
    return last;
  }

  /** ⑥ unknown: the next point's job on one transaction (deduplicated by its singletonKey). */
  async function sendNextPoint(
    row: QueryRow,
    schedule: QuerySchedule,
    firstTransfer: Date,
    point: number,
    now: Date,
  ): Promise<void> {
    const next = point + 1;
    const dueMs = firstTransfer.getTime() + queryPointOffsetSeconds(schedule, next) * 1000;
    const delaySeconds = Math.max(0, Math.ceil((dueMs - now.getTime()) / 1000));
    const payload: QueryJobPayload = {
      withdrawal_id: row.id,
      execute_seq: row.execute_seq,
      app_id: row.app_id,
      point: next,
    };
    await db
      .transaction()
      .execute((trx) =>
        queue.send(
          PAYOUT_QUEUE,
          PAYOUT_QUERY_JOB,
          { ...payload },
          { trx, singletonKey: `${row.id}:${row.execute_seq}:query:${next}`, delaySeconds },
        ),
      );
    logger.info(
      {
        withdrawal_id: row.id,
        out_biz_no: row.out_biz_no,
        point: next,
        delay_seconds: delaySeconds,
      },
      'payout_query_scheduled',
    );
  }

  return async function queryJob(job: ReceivedJob): Promise<void> {
    const payload = parsePayload(job);
    if (payload === null) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_query_bad_payload');
      return;
    }
    const now = clock.now();
    const prepared = await prepare(payload, now);
    if (prepared.kind === 'done') return;
    if (prepared.kind === 'manual') {
      // ④ after the read transaction: couli_payout's own connection must not wait on the row lock.
      await markNeedsManual(attemptsDb, prepared.row, payload.point, now, logger);
      return;
    }
    const { row, schedule } = prepared;
    const adapter = isChannel(row.payout_channel) ? channels[row.payout_channel] : undefined;
    if (adapter === undefined) {
      logger.warn(
        { withdrawal_id: row.id, out_biz_no: row.out_biz_no, channel: row.payout_channel },
        'payout_query_no_channel',
      );
      return;
    }
    // ⑤ outside any transaction.
    const result = await queryPoint(row, adapter, payload.point);
    const landedAt = clock.now();
    // ⑥
    if (result === null || result.kind === 'unknown') {
      await sendNextPoint(row, schedule, prepared.firstTransferAt, payload.point, landedAt);
    } else if (result.kind === 'success') {
      await landing.success(row, result, landedAt);
    } else {
      await landing.fail(row, result, landedAt);
    }
  };
}

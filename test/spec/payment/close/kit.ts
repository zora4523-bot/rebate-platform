// B2-15d rule-test kit (claude-independent, SPEC_REF ec81e625; 08 BR-PAY-05 ①～③, BR-PAY-02 PO2 /
// PO3, BR-PAY-03 取参数与关单互斥; task §9 / §10).
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (orders/kit.ts), ledger's posting,
// the pay queue's handler of B2-15c (result/kit.ts), and for the restart tests pg-boss itself
// (platform/queue createQueueRuntime on the test database, the real catalog and entry plan).
// Synthetic: the two channels. CloseChannel scripts what query and close answer for one merchant
// order number (paid / not paid / closed / not exist / timeout; close as the channel would, unknown,
// or the user paying just before the close lands) and records every call with the injected clock's
// instant. The documented answers it stands for: WeChat Pay 关闭订单 answers 204 and a later query
// reports trade_state CLOSED, a missing order ORDER_NOT_EXIST (docs-mirror/wechat-pay/pages/
// 4013070360.txt); Alipay alipay.trade.close / trade.query TRADE_CLOSED, ACQ.TRADE_NOT_EXIST (规划/09
// §5.7). Documented, not tested against the channels.
// The close handler is application/pay-close.ts runOrderClose (imported at run time, as
// result/kit.ts does with the job handler: the skeleton throws NotImplemented).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  PayChannelIdentity,
  PayCloseResult,
  PayQueryResult,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  createRootLogger,
  type FixedClock,
  type JobPayload,
  type QueueRuntime,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { Fixture, OrderRow } from '../orders/kit.ts';
import {
  AMOUNT,
  NOT_PAID,
  SpecPayChannel,
  attemptsOf,
  jobKit,
  payJobHandler,
  seedPending,
  sends,
  tradeNo,
  type JobDeps,
  type JobKit,
  type SentJob,
  type SpecTrade,
} from '../result/kit.ts';

/** Defaults of BR-PAY-05 细则 · 关单 (task §9.6). */
export const GRACE_MS = 10 * 60_000;
export const RETRY_SECONDS = 5 * 60;
export const WAIT_MS = 60 * 60_000;

/** The channel's own closed state (WeChat trade_state, Alipay trade_status; documented, 待实测). */
export const CLOSED_STATE: Record<PayChannelCode, string> = {
  wechat_pay: 'CLOSED',
  alipay: 'TRADE_CLOSED',
};

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Synthetic channel.

/** What the channel holds for a merchant order number (paid: see scriptPaid). */
export type TradeSetting = 'not_paid' | 'closed' | 'not_exist' | 'timeout';
/**
 * How close answers: `channel` as the channel would (not paid / closed → closed, the trade then
 * closed; paid → paid; not exist → not exist; timeout → unknown); `unknown` always; `pays` the user
 * pays just before the close lands (the trade becomes paid, close answers paid).
 */
export type CloseAnswer = 'channel' | 'unknown' | 'pays';

export interface ChannelCall {
  readonly op: 'query' | 'close';
  readonly outTradeNo: string;
  readonly at: Date;
}

export class CloseChannel extends SpecPayChannel {
  /** Every query and close, in order, with the clock's instant. */
  readonly calls: ChannelCall[] = [];
  /** Our merchant / application identity on this channel (owned by the fixture's app). */
  readonly identity: PayChannelIdentity;
  readonly #clock: FixedClock;
  readonly #trades = new Map<string, SpecTrade | TradeSetting>();
  readonly #answers = new Map<string, CloseAnswer>();
  readonly #amounts = new Map<string, bigint>();

  constructor(channel: PayChannelCode, clock: FixedClock, appId: string) {
    super(channel);
    this.#clock = clock;
    this.identity = this.own(appId);
  }

  /** Sets what query sees for the order and how close answers. */
  script(order: OrderRow, setting: TradeSetting, answer: CloseAnswer = 'channel'): void {
    this.#amounts.set(order.out_trade_no, order.amount_fen);
    this.#trades.set(order.out_trade_no, setting);
    this.#answers.set(order.out_trade_no, answer);
  }

  /** The order paid in full on the channel (our identity, success state); its trade number. */
  scriptPaid(order: OrderRow): string {
    const trade = tradeNo(this.channel);
    this.#amounts.set(order.out_trade_no, order.amount_fen);
    this.#trades.set(order.out_trade_no, this.paid(this.identity, order.amount_fen, trade));
    this.#answers.set(order.out_trade_no, 'channel');
    return trade;
  }

  /** The operations asked about one order, in order. */
  opsOf(order: OrderRow): ('query' | 'close')[] {
    return this.calls.filter((call) => call.outTradeNo === order.out_trade_no).map((c) => c.op);
  }

  override query(outTradeNo: string): Promise<PayQueryResult> {
    this.calls.push({ op: 'query', outTradeNo, at: this.#clock.now() });
    this.queried.push(outTradeNo);
    const trade = this.#trades.get(outTradeNo) ?? 'not_exist';
    if (trade === 'timeout') return Promise.resolve({ kind: 'unknown', reason: 'spec_timeout' });
    if (trade === 'not_exist') {
      return Promise.resolve({
        kind: 'ok',
        state: 'not_exist',
        channelTradeNo: null,
        amountFen: null,
      });
    }
    const ours = { merchantRef: this.identity.merchantRef, appRef: this.identity.appRef };
    if (trade === 'not_paid' || trade === 'closed') {
      return Promise.resolve({
        kind: 'ok',
        state: trade,
        channelTradeNo: null,
        amountFen: null,
        channelState: trade === 'not_paid' ? NOT_PAID[this.channel] : CLOSED_STATE[this.channel],
        ...ours,
      });
    }
    return Promise.resolve({
      kind: 'ok',
      state: trade.state,
      channelTradeNo: trade.channelTradeNo,
      amountFen: trade.amountFen,
      channelState: trade.channelState,
      ...ours,
    });
  }

  override close(outTradeNo: string): Promise<PayCloseResult> {
    this.calls.push({ op: 'close', outTradeNo, at: this.#clock.now() });
    const trade = this.#trades.get(outTradeNo) ?? 'not_exist';
    const answer = this.#answers.get(outTradeNo) ?? 'channel';
    if (trade === 'timeout' || answer === 'unknown') {
      return Promise.resolve({ kind: 'unknown', reason: 'spec_timeout' });
    }
    if (trade === 'not_exist') return Promise.resolve({ kind: 'ok', state: 'not_exist' });
    if (trade === 'not_paid' || trade === 'closed') {
      if (answer === 'pays') {
        const amount = this.#amounts.get(outTradeNo) ?? AMOUNT;
        this.#trades.set(outTradeNo, this.paid(this.identity, amount, tradeNo(this.channel)));
        return Promise.resolve({ kind: 'ok', state: 'paid' });
      }
      this.#trades.set(outTradeNo, 'closed');
      return Promise.resolve({ kind: 'ok', state: 'closed' });
    }
    // A paid trade cannot be closed.
    return Promise.resolve({ kind: 'ok', state: 'paid' });
  }
}

export type CloseChannels = Record<PayChannelCode, CloseChannel>;

/** Both channels on the fixture's clock, each with an identity owned by the fixture's app. */
export function closeChannels(f: Fixture): CloseChannels {
  return {
    wechat_pay: new CloseChannel('wechat_pay', f.clock, f.subject.app_id),
    alipay: new CloseChannel('alipay', f.clock, f.subject.app_id),
  };
}

// ---------------------------------------------------------------------------------------------
// Orders and the close job.

/** A PENDING order with launch parameters issued, in the close flow as the user's cancel leaves it. */
export function seedClosing(
  f: Fixture,
  channel: PayChannelCode,
  patch: Parameters<typeof seedPending>[2] = {},
): Promise<OrderRow> {
  return seedPending(f, channel, { closing: true, close_reason: 'user_cancel', ...patch });
}

/**
 * B2-15b's placement attempt of an order (pay_query_attempts kind query, request op create_order):
 * result 'prepay' (the channel took the order) or 'unknown' (the call's outcome is not known).
 */
export async function placementAttempt(
  f: Fixture,
  order: OrderRow,
  result: 'prepay' | 'unknown',
): Promise<void> {
  const request = {
    op: 'create_order',
    pay_channel: order.pay_channel,
    out_trade_no: order.out_trade_no,
    amount_fen: order.amount_fen.toString(),
    expire_at: order.expire_at.toISOString(),
  };
  const response =
    result === 'prepay' ? { kind: 'ok' } : { kind: 'unknown', reason: 'spec_timeout' };
  await sql`
    INSERT INTO app.pay_query_attempts
      (id, app_id, pay_order_id, kind, request, response, result, at, created_at)
    VALUES (${randomUUID()}::uuid, ${order.app_id}, ${order.id}::uuid, 'query',
      ${JSON.stringify(request)}::jsonb, ${JSON.stringify(response)}::jsonb, ${result},
      ${f.clock.now()}, ${f.clock.now()})`.execute(f.db);
}

/** The payload of `order.close` as B2-15b's cancel and B2-15c's expire_at query enqueue it. */
export function closePayload(order: OrderRow, reason: 'user_cancel' | 'expired'): JobPayload {
  return { app_id: order.app_id, pay_order_id: order.id, close_reason: reason };
}

export type CloseRun = (payload: JobPayload) => Promise<void>;

/** runOrderClose over the kit's dependencies (built inside the test: the skeleton throws). */
export async function closeRunner(kit: JobKit): Promise<CloseRun> {
  const module = (await import(
    new URL('apps/api/src/modules/payment/application/pay-close.ts', ROOT).href
  )) as { runOrderClose(deps: JobDeps, payload: unknown): Promise<void> };
  return async (payload) => {
    await module.runOrderClose(kit.deps, payload);
  };
}

/** The recorded order.close sends that name the order. */
export function closeSends(kit: JobKit, order: OrderRow): SentJob[] {
  return sends(kit, 'order.close').filter((job) => job.payload['pay_order_id'] === order.id);
}

/** pay_query_attempts rows of the order by kind. */
export async function attemptKinds(
  f: Fixture,
  order: OrderRow,
): Promise<{ query: number; close: number; other: number }> {
  const rows = await attemptsOf(f, order.id);
  return {
    query: rows.filter((row) => row.kind === 'query').length,
    close: rows.filter((row) => row.kind === 'close').length,
    other: rows.filter((row) => row.kind !== 'query' && row.kind !== 'close').length,
  };
}

// ---------------------------------------------------------------------------------------------
// pg-boss on the test database (the restart tests).

export interface CloseJobRow {
  readonly id: string;
  readonly state: string;
  readonly singleton_key: string | null;
  readonly delay: number;
  readonly payload: JobPayload | null;
}

/** The order.close jobs of queue `pay` whose data mentions the order (pgboss.job, oldest first). */
export async function closeJobs(f: Fixture, order: OrderRow): Promise<CloseJobRow[]> {
  const result = await sql<CloseJobRow>`
    SELECT id::text AS id, state::text AS state, singleton_key, data->'payload' AS payload,
      extract(epoch FROM (start_after - created_on))::float8 AS delay
    FROM pgboss.job
    WHERE name = 'pay' AND data->>'name' = 'order.close' AND data::text LIKE ${`%${order.id}%`}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** Makes a delayed job due now (the wait a test cannot spend in real time). */
export async function dueNow(f: Fixture, jobId: string): Promise<void> {
  await sql`UPDATE pgboss.job SET start_after = now() WHERE name = 'pay' AND id = ${jobId}::uuid`.execute(
    f.db,
  );
}

function queueRuntime(f: Fixture, entry: 'api' | 'worker', lines: string[]): QueueRuntime {
  return createQueueRuntime({
    entry,
    db: f.db,
    logger: createRootLogger(
      { entry, appEnv: 'test', level: 'warn' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    ),
  });
}

/** Enqueues on an api entry's job queue that then stops (the process that enqueued is gone). */
export async function enqueueAndStop(
  f: Fixture,
  name: string,
  payload: JobPayload,
  singletonKey: string,
): Promise<string | null> {
  const runtime = queueRuntime(f, 'api', []);
  try {
    await runtime.start();
    return await runtime.send('pay', name, payload, { trx: null, singletonKey });
  } finally {
    await runtime.stop();
  }
}

/**
 * A worker process: a fresh job queue of the worker entry with the pay queue's handler
 * (createPayJobHandler, registered as the worker registers it) over fresh dependencies, started;
 * stopped when `run` ends.
 */
export async function withWorker(
  f: Fixture,
  channels: CloseChannels,
  run: (kit: JobKit) => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  const runtime = queueRuntime(f, 'worker', lines);
  try {
    const kit = await jobKit(f, channels, { queue: runtime });
    runtime.register('pay', await payJobHandler(kit));
    await runtime.start();
    await run(kit);
  } finally {
    await runtime.stop();
  }
}

/** Polls `check` until it holds or `timeoutMs` (real time) runs out; the last answer. */
export async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

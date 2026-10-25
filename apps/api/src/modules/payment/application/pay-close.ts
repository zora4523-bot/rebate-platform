// B2-15d: the close flow of one pay order, the handler of job `order.close` (08 BR-PAY-05 ①～③,
// BR-PAY-02 PO2 / PO3, BR-PAY-03 取参数与关单在同一把业务对象锁内互斥; task §9.1 ～ §9.6, §11).
// One run, in three steps:
//   ① under the business object lock, on a fresh read by (app_id, pay_order_id): not PENDING, or
//      needs_manual → nothing; PENDING and not closing → before expire_at nothing, from expire_at
//      on closing with close_reason expired (a CAS; from then on B2-15b returns no launch
//      parameters, the same lock serialises the two). Never placed (no pay_query_attempts row at
//      all) and no launch issued → PO3 in this very transaction, no channel call.
//   ② outside any transaction: the channel query (one pay_query_attempts row, committed before any
//      judgement). paid → B2-15c's judgement and settlement (PO2, never closed; a CLOSED order is an
//      anomaly receipt there). not paid / closed → the channel's close (one kind close row); only
//      an explicit «closed» answer is a PO3; a close answered «paid» (the user paid just before)
//      is queried once more and judged. «not exist» → PO3 only on a query made at or after
//      expire_at + pay.close_grace_minutes. unknown → nothing moves.
//   ③ still PENDING: under the lock, from expire_at + pay.close_wait_minutes on needs_manual and
//      the alert pay_order_needs_manual, nothing enqueued; before it the next run, enqueued on the
//      same transaction, on the grid expire_at + k × pay.close_retry_minutes (domain/
//      close-schedule.ts) with a singletonKey of its instant (one chain per order).
// Every PO3 re-reads under the lock and moves by the generated transition() and a CAS; a
// notification settling concurrently wins or loses as a whole (BR-PAY-02; task §9.4). No user
// account and no ledger posting here other than B2-15c's settlement / anomaly receipt.
// Channel facts (documented, not tested against the channels): WeChat Pay 关闭订单 answers 204
// and a later query reports trade_state CLOSED, a missing order ORDER_NOT_EXIST
// (docs-mirror/wechat-pay/pages/4013070360.txt); Alipay alipay.trade.close / trade.query
// TRADE_CLOSED, ACQ.TRADE_NOT_EXIST (规划/09 §5.7). The adapters map them onto PayCloseResult /
// PayQueryResult (B2-15k).
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import { transitionPayOrder } from '@couli/domain';
import { newUuidV7 } from '../../platform/index.ts';
import {
  CLOSE_GRACE_MINUTES_KEY,
  CLOSE_RETRY_MINUTES_KEY,
  CLOSE_WAIT_MINUTES_KEY,
  DEFAULT_CLOSE_GRACE_MINUTES,
  DEFAULT_CLOSE_RETRY_MINUTES,
  DEFAULT_CLOSE_WAIT_MINUTES,
  closeMinutesOf,
  closeWaitOver,
  nextCloseRunAt,
  notExistMayClose,
  type CloseSettings,
} from '../domain/close-schedule.ts';
import { delaySecondsUntil } from '../domain/pay-result.ts';
import type { PayChannelCode } from '../domain/types.ts';
import {
  findOrderById,
  hasAnyAttempt,
  insertQueryAttempt,
  lockBizObject,
  markClosed,
  markClosing,
  markNeedsManual,
  type BizObjectKey,
  type PayOrderRow,
} from '../infra/pay-order-store.ts';
import {
  ORDER_CLOSE_JOB,
  PAY_QUEUE,
  orderCloseRunKey,
  type OrderClosePayload,
} from '../jobs/names.ts';
import type { PayChannel, PayCloseResult, PayQueryResult } from './pay-channel.ts';
import { judgePaidAnswer, queryChannel, type Outcome, type PayQueryDeps } from './pay-query.ts';
import { PaySettlementConflict, rawConfigValue } from './pay-settlement.ts';

/** The close flow asks the channel, settles a paid answer (PO2) and enqueues its own next run. */
export type PayCloseDeps = PayQueryDeps;

const CLOSE_REASONS: readonly string[] = ['user_cancel', 'expired'];

function isPayload(value: unknown): value is OrderClosePayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['app_id'] === 'string' &&
    typeof p['pay_order_id'] === 'string' &&
    typeof p['close_reason'] === 'string' &&
    CLOSE_REASONS.includes(p['close_reason'])
  );
}

function bizKeyOf(order: PayOrderRow): BizObjectKey {
  return { appId: order.app_id, bizType: order.biz_type, bizRef: order.biz_ref };
}

/** The three close settings of the app (config_items overrides the code defaults; also B2-15f). */
export async function closeSettingsOf(deps: PayCloseDeps, appId: string): Promise<CloseSettings> {
  const read = async (key: string, fallback: number): Promise<number> => {
    const value = closeMinutesOf(await rawConfigValue(deps.config, appId, key), fallback);
    if (value.fallback) deps.logger.warn({ app_id: appId, key }, 'pay_close_setting_invalid');
    return value.minutes;
  };
  return {
    graceMinutes: await read(CLOSE_GRACE_MINUTES_KEY, DEFAULT_CLOSE_GRACE_MINUTES),
    retryMinutes: await read(CLOSE_RETRY_MINUTES_KEY, DEFAULT_CLOSE_RETRY_MINUTES),
    waitMinutes: await read(CLOSE_WAIT_MINUTES_KEY, DEFAULT_CLOSE_WAIT_MINUTES),
  };
}

/** What step ① left: nothing to do, closed at once, or an order whose state the channel decides. */
type Entry =
  | { readonly kind: 'done' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'ask'; readonly order: PayOrderRow };

/**
 * PO3 on the caller's locked transaction for an order it re-read as PENDING; false on a lost CAS
 * (also B2-15f's manual settlement, application/pay-resolve.ts).
 */
export async function closeOrder(
  deps: PayCloseDeps,
  trx: Parameters<typeof markClosed>[0],
  order: PayOrderRow,
  basis: string,
): Promise<boolean> {
  const move = transitionPayOrder('PENDING', 'CLOSE');
  if (!move.ok || move.to !== 'CLOSED') throw new Error('payment: PO3 is not a transition');
  const closed = await markClosed(trx, order.app_id, order.id, deps.clock.now());
  if (closed === undefined) return false;
  deps.logger.info(
    {
      app_id: closed.app_id,
      pay_order_id: closed.id,
      pay_channel: closed.pay_channel,
      close_reason: closed.close_reason,
      basis,
    },
    'pay_order_closed',
  );
  return true;
}

/** Step ①: lock, re-read, enter the close flow, and close an order the channel never saw. */
async function enter(deps: PayCloseDeps, seen: PayOrderRow): Promise<Entry> {
  return deps.db.transaction().execute(async (trx): Promise<Entry> => {
    await lockBizObject(trx, bizKeyOf(seen));
    let order = await findOrderById(trx, seen.app_id, seen.id);
    if (order === undefined || order.status !== 'PENDING' || order.needs_manual) {
      return { kind: 'done' };
    }
    const now = deps.clock.now();
    if (!order.closing) {
      // Not cancelled: only an order past its pay time limit enters the close flow (BR-PAY-05).
      if (now.getTime() < order.expire_at.getTime()) return { kind: 'done' };
      const entered = await markClosing(trx, order.app_id, order.id, 'expired', now);
      if (entered === undefined) return { kind: 'done' };
      order = entered;
    }
    // BR-PAY-05 ①: no placement attempt (nor any other channel call) recorded and no launch
    // parameters issued — the channel never had this order, close it without asking.
    if (order.launch_issued_at === null && !(await hasAnyAttempt(trx, order.app_id, order.id))) {
      return (await closeOrder(deps, trx, order, 'never_placed'))
        ? { kind: 'closed' }
        : { kind: 'done' };
    }
    return { kind: 'ask', order };
  });
}

/** PO3 after the channel's answer: lock, re-read, CAS (a settlement may have won meanwhile). */
async function closeAfterAnswer(
  deps: PayCloseDeps,
  order: PayOrderRow,
  basis: string,
): Promise<Outcome> {
  return deps.db.transaction().execute(async (trx): Promise<Outcome> => {
    await lockBizObject(trx, bizKeyOf(order));
    const fresh = await findOrderById(trx, order.app_id, order.id);
    if (fresh === undefined || fresh.status !== 'PENDING') return 'closed';
    return (await closeOrder(deps, trx, fresh, basis)) ? 'closed' : 'open';
  });
}

async function closeChannel(adapter: PayChannel, outTradeNo: string): Promise<PayCloseResult> {
  try {
    return await adapter.close(outTradeNo);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer (payment/AGENTS.md rule 7): queried later, not resent.
    return {
      kind: 'unknown',
      reason: error instanceof Error ? `adapter_error:${error.name}` : 'adapter_error',
    };
  }
}

/**
 * One query of the close flow, its attempt row committed on its own before any judgement (also
 * B2-15f's manual settlement, trigger admin_resolve: the recorded response is its evidence).
 */
export async function recordedQuery(
  deps: PayCloseDeps,
  adapter: PayChannel,
  order: PayOrderRow,
  trigger: 'close' | 'admin_resolve' = 'close',
): Promise<{ readonly result: PayQueryResult; readonly attemptId: string }> {
  const result = await queryChannel(adapter, order.out_trade_no);
  const now = deps.clock.now();
  const attemptId = newUuidV7(now);
  await deps.db.transaction().execute((trx) =>
    insertQueryAttempt(trx, {
      id: attemptId,
      appId: order.app_id,
      payOrderId: order.id,
      kind: 'query',
      request: {
        op: 'query',
        pay_channel: order.pay_channel,
        out_trade_no: order.out_trade_no,
        trigger,
      },
      response:
        result.kind === 'ok'
          ? {
              kind: 'ok',
              state: result.state,
              channel_state: result.channelState ?? null,
              channel_trade_no: result.channelTradeNo,
              amount_fen: result.amountFen === null ? null : result.amountFen.toString(),
              identity_reported: result.merchantRef !== undefined && result.appRef !== undefined,
            }
          : { kind: 'unknown', reason: result.reason },
      result: result.kind === 'ok' ? result.state : 'unknown',
      at: now,
    }),
  );
  return { result, attemptId };
}

/** The channel's close, its attempt row written right after the call (the table is insert-only). */
async function recordedClose(
  deps: PayCloseDeps,
  adapter: PayChannel,
  order: PayOrderRow,
): Promise<PayCloseResult> {
  const result = await closeChannel(adapter, order.out_trade_no);
  const now = deps.clock.now();
  await deps.db.transaction().execute((trx) =>
    insertQueryAttempt(trx, {
      id: newUuidV7(now),
      appId: order.app_id,
      payOrderId: order.id,
      kind: 'close',
      request: {
        op: 'close',
        pay_channel: order.pay_channel,
        out_trade_no: order.out_trade_no,
        close_reason: order.close_reason,
      },
      response:
        result.kind === 'ok'
          ? { kind: 'ok', state: result.state }
          : { kind: 'unknown', reason: result.reason },
      result: result.kind === 'ok' ? result.state : 'unknown',
      at: now,
    }),
  );
  return result;
}

/** A paid answer: B2-15c's checks and settlement; a lost race leaves the decision to step ③. */
async function judgePaid(
  deps: PayCloseDeps,
  adapter: PayChannel,
  order: PayOrderRow,
  result: Extract<PayQueryResult, { kind: 'ok' }>,
  attemptId: string,
): Promise<Outcome> {
  try {
    return await judgePaidAnswer(deps, adapter, order, result, attemptId);
  } catch (error: unknown) {
    // Another judgement moved the order first: step ③ re-reads it and ends.
    if (error instanceof PaySettlementConflict) return 'open';
    throw error;
  }
}

/** Step ②: what the channel says, and what it allows. «open»: no result yet. */
async function ask(
  deps: PayCloseDeps,
  order: PayOrderRow,
  settings: CloseSettings,
): Promise<{ readonly outcome: Outcome; readonly waitingGrace: boolean }> {
  const adapter = deps.channels.of(order.pay_channel as PayChannelCode);
  const base = { app_id: order.app_id, pay_order_id: order.id, pay_channel: order.pay_channel };
  const queried = await recordedQuery(deps, adapter, order);
  const answer = queried.result;
  if (answer.kind === 'unknown') {
    deps.logger.warn({ ...base, reason: answer.reason }, 'pay_close_query_unknown');
    return { outcome: 'open', waitingGrace: false };
  }
  switch (answer.state) {
    case 'paid':
      // BR-PAY-05 ②: paid on the channel → PO2 (after the checks of BR-PAY-04), never closed.
      return {
        outcome: await judgePaid(deps, adapter, order, answer, queried.attemptId),
        waitingGrace: false,
      };
    case 'not_exist':
      // «单据不存在» is not «closed»: only a query at or after expire_at + grace may close it.
      if (notExistMayClose(deps.clock.now(), order.expire_at, settings)) {
        return {
          outcome: await closeAfterAnswer(deps, order, 'not_exist_after_grace'),
          waitingGrace: false,
        };
      }
      return { outcome: 'open', waitingGrace: true };
    case 'not_paid':
    case 'closed':
      break;
  }
  const closed = await recordedClose(deps, adapter, order);
  if (closed.kind === 'unknown') {
    deps.logger.warn({ ...base, reason: closed.reason }, 'pay_close_unknown');
    return { outcome: 'open', waitingGrace: false };
  }
  if (closed.state === 'closed') {
    return { outcome: await closeAfterAnswer(deps, order, 'channel_closed'), waitingGrace: false };
  }
  if (closed.state === 'paid') {
    // The user paid just before the close landed: ask once more, settle a confirmed payment.
    const again = await recordedQuery(deps, adapter, order);
    if (again.result.kind === 'ok' && again.result.state === 'paid') {
      return {
        outcome: await judgePaid(deps, adapter, order, again.result, again.attemptId),
        waitingGrace: false,
      };
    }
    return { outcome: 'open', waitingGrace: false };
  }
  // A close answered «not exist» after a query that found the order: no result yet.
  deps.logger.warn({ ...base, reason: 'close_not_exist' }, 'pay_close_unknown');
  return { outcome: 'open', waitingGrace: false };
}

/** Step ③: still PENDING → the next run, or needs_manual once the wait is over. */
async function follow(
  deps: PayCloseDeps,
  order: PayOrderRow,
  settings: CloseSettings,
  waitingGrace: boolean,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    await lockBizObject(trx, bizKeyOf(order));
    const fresh = await findOrderById(trx, order.app_id, order.id);
    if (fresh === undefined || fresh.status !== 'PENDING' || fresh.needs_manual) return;
    const now = deps.clock.now();
    if (closeWaitOver(now, fresh.expire_at, settings)) {
      const manual = await markNeedsManual(trx, fresh.app_id, fresh.id, now);
      if (manual !== undefined) {
        // The alert (BR-PAY-05 ③): ids only; the back office ends it (B2-15f).
        deps.logger.warn(
          {
            app_id: manual.app_id,
            pay_order_id: manual.id,
            pay_channel: manual.pay_channel,
            close_reason: manual.close_reason,
          },
          'pay_order_needs_manual',
        );
      }
      return;
    }
    const runAt = nextCloseRunAt(now, fresh.expire_at, settings, waitingGrace);
    const payload: OrderClosePayload = {
      app_id: fresh.app_id,
      pay_order_id: fresh.id,
      close_reason: fresh.close_reason === 'user_cancel' ? 'user_cancel' : 'expired',
    };
    await deps.queue.send(PAY_QUEUE, ORDER_CLOSE_JOB, payload, {
      trx,
      singletonKey: orderCloseRunKey(fresh.id, runAt),
      delaySeconds: delaySecondsUntil(now, runAt),
    });
    deps.logger.info(
      { app_id: fresh.app_id, pay_order_id: fresh.id, run_at: runAt.toISOString() },
      'pay_order_close_renewed',
    );
  });
}

/**
 * The handler of `order.close` (payload OrderClosePayload: app_id, pay_order_id, close_reason).
 * At-least-once safe: every step re-reads under the lock, every move is a CAS, and the next run's
 * singletonKey is its instant.
 */
export async function runOrderClose(deps: PayCloseDeps, payload: unknown): Promise<void> {
  if (!isPayload(payload)) throw new Error('payment: order.close payload is malformed');
  const seen = await findOrderById(deps.db, payload.app_id, payload.pay_order_id);
  if (seen === undefined) {
    deps.logger.warn(
      { app_id: payload.app_id, pay_order_id: payload.pay_order_id },
      'pay_close_order_missing',
    );
    return;
  }
  const entry = await enter(deps, seen);
  if (entry.kind !== 'ask') return;
  const settings = await closeSettingsOf(deps, entry.order.app_id);
  const asked = await ask(deps, entry.order, settings);
  if (asked.outcome !== 'open') return;
  await follow(deps, entry.order, settings, asked.waitingGrace);
}

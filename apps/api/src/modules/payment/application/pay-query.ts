// B2-15c: the active query of one pay order (08 BR-PAY-04 「服务端主动查询的结果」, BR-PAY-05 ④;
// task §9.4 ～ §9.6; D-PAY-11), the handler of job `order.query`. Two triggers:
//   returned   the client came back from the SDK (B2-15b enqueued it): one query, no follow-up;
//   scheduled  a slot of pay.query_schedule, enqueued at placement and by the previous slot; a
//              still PENDING order gets the next slot relative to its creation (a late run skips
//              the slots already behind, never catches them up), and at expire_at the order is
//              handed to order.close (B2-15d decides what to do with it).
// Every query writes one pay_query_attempts row (kind query, result = the channel's state as
// reported, D10-236 ②) in its own transaction before any judgement, so the attempt stays when the
// settlement is rolled back (rule-test review r1, AC#31). A channel answer of paid is judged by
// the same checks as a notification (identity through ownerAppOf, amount, state ∈
// success_states), under the business object lock on a fresh read, and settled through the same
// settlement; a PAID order is not queried again; a CLOSED order the channel reports paid is an
// anomaly receipt (BR-PAY-05 ④), never a PO2 and never followed by another slot or a close job.
// A channel answer without state / amount / identity never counts as paid (fail closed).
// Nothing of a channel-side user reaches a log line; amounts stay bigint fen.
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import {
  delaySecondsUntil,
  judgePayResult,
  nextQueryInstant,
  queryInstants,
  queryScheduleOf,
  querySlotSeconds,
} from '../domain/pay-result.ts';
import type { PayChannelCode } from '../domain/types.ts';
import {
  findOrderById,
  insertQueryAttempt,
  lockBizObject,
  type PayOrderRow,
} from '../infra/pay-order-store.ts';
import {
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  PAY_QUEUE,
  orderCloseKey,
  orderQueryScheduledKey,
  type OrderClosePayload,
  type OrderQueryPayload,
  type OrderQueryScheduledPayload,
} from '../jobs/names.ts';
import type { PayChannel, PayChannelSet, PayQueryResult } from './pay-channel.ts';
import {
  PaySettlementConflict,
  QUERY_SCHEDULE_KEY,
  rawConfigValue,
  registerAnomalyReceipt,
  settlePendingOrder,
  successStatesFor,
  type PaySettlementDeps,
} from './pay-settlement.ts';

export interface PayQueryDeps extends PaySettlementDeps {
  readonly db: Kysely<DB>;
  readonly channels: Pick<PayChannelSet, 'of'>;
}

/** What the query left the order as (decides the follow-up of a scheduled slot). */
type Outcome = 'settled' | 'already_paid' | 'anomaly' | 'open' | 'closed';

function isPayload(value: unknown): value is OrderQueryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p['app_id'] !== 'string') return false;
  if (p['trigger'] === 'returned') return typeof p['pay_order_id'] === 'string';
  if (p['trigger'] === 'scheduled') return typeof p['out_trade_no'] === 'string';
  return false;
}

/** The order a payload names, by id (returned) or by its merchant number (scheduled). */
async function orderOf(
  db: Kysely<DB>,
  payload: OrderQueryPayload,
): Promise<PayOrderRow | undefined> {
  if (payload.trigger === 'returned')
    return findOrderById(db, payload.app_id, payload.pay_order_id);
  // The scheduled payload does not carry the channel: the number is unique per app.
  const order = await db
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', payload.app_id)
    .where('out_trade_no', '=', payload.out_trade_no)
    .executeTakeFirst();
  return order;
}

async function queryChannel(adapter: PayChannel, outTradeNo: string): Promise<PayQueryResult> {
  try {
    return await adapter.query(outTradeNo);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer (payment/AGENTS.md rule 7).
    return {
      kind: 'unknown',
      reason: error instanceof Error ? `adapter_error:${error.name}` : 'adapter_error',
    };
  }
}

/**
 * Enqueues the slot after `now` of a still PENDING order, or its close job once the expire_at
 * query is behind (BR-PAY-04 查询节奏; past expire_at the rhythm is B2-15d's).
 */
export async function scheduleNextQuery(
  deps: PayQueryDeps,
  order: PayOrderRow,
  now: Date,
): Promise<void> {
  const schedule = queryScheduleOf(
    await rawConfigValue(deps.config, order.app_id, QUERY_SCHEDULE_KEY),
  );
  if (schedule.fallback) {
    deps.logger.warn(
      { app_id: order.app_id, key: QUERY_SCHEDULE_KEY },
      'pay_query_schedule_invalid',
    );
  }
  const next = nextQueryInstant(
    queryInstants(order.created_at, order.expire_at, schedule.seconds),
    now,
  );
  if (next === null) {
    const payload: OrderClosePayload = {
      app_id: order.app_id,
      pay_order_id: order.id,
      close_reason: 'expired',
    };
    await deps.queue.send(PAY_QUEUE, ORDER_CLOSE_JOB, payload, {
      trx: null,
      singletonKey: orderCloseKey(order.id),
    });
    deps.logger.info({ app_id: order.app_id, pay_order_id: order.id }, 'pay_order_close_queued');
    return;
  }
  const payload: OrderQueryScheduledPayload = {
    app_id: order.app_id,
    out_trade_no: order.out_trade_no,
    trigger: 'scheduled',
  };
  await deps.queue.send(PAY_QUEUE, ORDER_QUERY_JOB, payload, {
    trx: null,
    singletonKey: orderQueryScheduledKey(order.id, querySlotSeconds(order.created_at, next)),
    delaySeconds: delaySecondsUntil(now, next),
  });
}

/** The handler of `order.query` (payload of B2-15b's returned query or of a scheduled slot). */
export async function runOrderQuery(deps: PayQueryDeps, payload: unknown): Promise<void> {
  if (!isPayload(payload)) throw new Error('payment: order.query payload is malformed');
  const order = await orderOf(deps.db, payload);
  if (order === undefined) {
    deps.logger.warn(
      { app_id: payload.app_id, trigger: payload.trigger },
      'pay_query_order_missing',
    );
    return;
  }
  if (order.status === 'PAID') {
    // Settled already (a notification or an earlier query): nothing to ask, nothing to schedule.
    deps.logger.info(
      { app_id: order.app_id, pay_order_id: order.id, trigger: payload.trigger },
      'pay_query_skipped_paid',
    );
    return;
  }
  const channel = order.pay_channel as PayChannelCode;
  const adapter = deps.channels.of(channel);
  const result = await queryChannel(adapter, order.out_trade_no);
  const now = deps.clock.now();
  const attemptId = newUuidV7(now);
  // The attempt row commits on its own, before the judgement (it must survive a rolled-back
  // settlement; the channel was asked whatever happens next).
  await deps.db.transaction().execute((trx) =>
    insertQueryAttempt(trx, {
      id: attemptId,
      appId: order.app_id,
      payOrderId: order.id,
      kind: 'query',
      request: {
        op: 'query',
        pay_channel: channel,
        out_trade_no: order.out_trade_no,
        trigger: payload.trigger,
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

  let outcome: Outcome = order.status === 'CLOSED' ? 'closed' : 'open';
  if (result.kind === 'unknown') {
    deps.logger.warn(
      { app_id: order.app_id, pay_order_id: order.id, pay_channel: channel, reason: result.reason },
      'pay_query_unknown',
    );
  } else if (result.state === 'paid') {
    outcome = await judgePaidAnswer(deps, adapter, order, result, attemptId);
  }
  if (payload.trigger === 'scheduled' && outcome === 'open') {
    // Re-read: the judgement may have left the order PENDING but closing (B2-15d owns it then).
    const fresh = await findOrderById(deps.db, order.app_id, order.id);
    if (fresh !== undefined && fresh.status === 'PENDING' && !fresh.closing) {
      await scheduleNextQuery(deps, fresh, now);
    }
  }
}

/** A channel answer of paid: the checks of BR-PAY-04, then the settlement or the anomaly. */
async function judgePaidAnswer(
  deps: PayQueryDeps,
  adapter: PayChannel,
  order: PayOrderRow,
  result: Extract<PayQueryResult, { kind: 'ok' }>,
  attemptId: string,
): Promise<Outcome> {
  const channel = order.pay_channel as PayChannelCode;
  const base = { app_id: order.app_id, pay_order_id: order.id, out_trade_no: order.out_trade_no };
  if (
    result.channelState === undefined ||
    result.amountFen === null ||
    result.channelTradeNo === null ||
    result.merchantRef === undefined ||
    result.appRef === undefined
  ) {
    // Fail closed: a paid answer without the facts to check is not a payment (task §11).
    deps.logger.warn({ ...base, pay_channel: channel, reason: 'incomplete' }, 'pay_query_mismatch');
    return order.status === 'CLOSED' ? 'closed' : 'open';
  }
  const facts = {
    ours:
      adapter.ownerAppOf({ merchantRef: result.merchantRef, appRef: result.appRef }) ===
      order.app_id,
    amountFen: result.amountFen,
    channelState: result.channelState,
    channelTradeNo: result.channelTradeNo,
  };
  const successStates = await successStatesFor(deps, order.app_id, channel);
  try {
    return await deps.db.transaction().execute(async (trx): Promise<Outcome> => {
      await lockBizObject(trx, {
        appId: order.app_id,
        bizType: order.biz_type,
        bizRef: order.biz_ref,
      });
      const fresh = await findOrderById(trx, order.app_id, order.id);
      if (fresh === undefined) throw new Error('payment: the queried order vanished');
      const verdict = judgePayResult({
        ours: facts.ours,
        order: {
          status: fresh.status as 'PENDING' | 'PAID' | 'CLOSED',
          amountFen: fresh.amount_fen,
        },
        amountFen: facts.amountFen,
        channelState: facts.channelState,
        successStates,
      });
      switch (verdict.kind) {
        case 'rejected':
          deps.logger.warn(
            { ...base, pay_channel: channel, reason: 'identity_not_ours' },
            'pay_query_rejected',
          );
          return fresh.status === 'CLOSED' ? 'closed' : 'open';
        case 'mismatch':
          deps.logger.warn(
            { ...base, pay_channel: channel, reason: verdict.reason },
            'pay_query_mismatch',
          );
          return fresh.status === 'CLOSED' ? 'closed' : 'open';
        case 'settle':
          await settlePendingOrder(deps, trx, fresh, {
            channelTradeNo: facts.channelTradeNo,
            source: 'query',
          });
          return 'settled';
        case 'already_paid':
          return 'already_paid';
        case 'anomaly':
          await registerAnomalyReceipt(deps, trx, {
            appId: fresh.app_id,
            payChannel: channel,
            channelTradeNo: facts.channelTradeNo,
            outTradeNo: fresh.out_trade_no,
            payOrderId: fresh.id,
            amountFen: facts.amountFen,
            channelState: facts.channelState,
            source: 'query',
            evidenceRef: `pay_query_attempt:${attemptId}`,
          });
          return 'anomaly';
      }
    });
  } catch (error: unknown) {
    // A conflict: another judgement moved the order first; the job fails and the queue may run it
    // again (then it finds the order PAID and asks nothing). Any other error fails the job as is.
    if (error instanceof PaySettlementConflict) {
      deps.logger.warn({ ...base, pay_channel: channel }, 'pay_query_conflict');
    }
    throw error;
  }
}

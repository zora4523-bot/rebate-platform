// B3-08g · BR-AI-03 / BR-AI-07: the production ports behind list_my_orders / explain_order that
// agent owns itself (kept outside tools/registry/**). The rule tests in
// test/spec/agent/stream-assembly-orders/** import this file by path: names, signatures and the
// semantics written here are the contract.
//
// createOrderCardRefs(db): OrderCardRefs. resolve(cardId, ctx) reads app.agent_cards (agent is the
//   writer of that table) for the row with app_id = ctx.appId, session_id = ctx.sessionId, card_id =
//   cardId and type 'order_status'. Its data.order_id (a non-empty string) gives
//   {kind: 'order', orderId}. Everything else is {kind: 'invalid'}: no such row, the same card_id in
//   another session or app, another card type, data cleared to {} (or without order_id), a card_id
//   that is not ^c[1-9]\d*$. The session and the app come only from ctx (server side), never from a
//   model argument. Read errors propagate (the tool answers tool_failed).
// DailyCounter.incr(key, expireAt): atomically adds 1 to `key` and resolves the new count; the key
//   expires at `expireAt`. Production: app.module's Redis counter (INCR + expiry at expireAt); no
//   Redis or a Redis error rejects.
// createOrderNoQuota({counter, clock, config}): OrderNoQuota. take(appId, userId) counts one
//   explain_order-by-number lookup (BR-AI-07 判定 4): the day is the +08:00 calendar day of
//   clock.now(); the counter key carries appId, userId and that day; expireAt is the next +08:00
//   midnight (16:00Z). The limit is config(appId, 'agent.explain_order.order_no_daily_max') when it
//   is a positive safe integer, else orderNoDailyMaxDefault() (missing, malformed or a failing read).
//   Resolves true while the new count is within the limit, false once over it. A counter failure
//   rejects: never allowed through.
// orderNoDailyMaxDefault(): 20.
import { accountingDate, chinaDayRange } from '@couli/domain';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../../platform/index.ts';
import { isUuid } from '../../store/index.ts';
import { isCardId } from '../../store/results/index.ts';
import type { OrderCardRefs, OrderNoQuota } from '../../tools/orders/index.ts';

/** One atomic per-key counter with an absolute expiry instant. */
export interface DailyCounter {
  incr(key: string, expireAt: Date): Promise<number>;
}

export interface OrderNoQuotaDeps {
  readonly counter: DailyCounter;
  readonly clock: Clock;
  config(appId: string, key: string): Promise<unknown>;
}

const ORDER_STATUS = 'order_status';
const DAILY_MAX_KEY = 'agent.explain_order.order_no_daily_max';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createOrderCardRefs(db: Kysely<DB>): OrderCardRefs {
  const app = db.withSchema('app');
  return {
    async resolve(cardId, ctx) {
      // Malformed ids are no card at all (and never reach the uuid / check-constrained columns).
      if (!isCardId(cardId) || !isUuid(ctx.sessionId)) {
        return { kind: 'invalid' };
      }
      const row = await app
        .selectFrom('agent_cards')
        .select('data')
        .where('app_id', '=', ctx.appId)
        .where('session_id', '=', ctx.sessionId)
        .where('card_id', '=', cardId)
        .where('type', '=', ORDER_STATUS)
        .executeTakeFirst();
      const data: unknown = row?.data;
      const orderId = isRecord(data) ? data['order_id'] : undefined;
      return typeof orderId === 'string' && orderId !== ''
        ? { kind: 'order', orderId }
        : { kind: 'invalid' };
    },
  };
}

async function dailyMax(deps: OrderNoQuotaDeps, appId: string): Promise<number> {
  let value: unknown;
  try {
    value = await deps.config(appId, DAILY_MAX_KEY);
  } catch {
    return orderNoDailyMaxDefault();
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : orderNoDailyMaxDefault();
}

/** The +08:00 calendar day of `now` (YYYY-MM-DD) and the instant of the next +08:00 midnight. */
function plusEightDay(now: Date): { readonly day: string; readonly nextMidnight: Date } {
  const day = accountingDate(now);
  const nextMidnight = structuredClone(now);
  nextMidnight.setTime(Date.parse(chinaDayRange(day).end));
  return { day, nextMidnight };
}

export function createOrderNoQuota(deps: OrderNoQuotaDeps): OrderNoQuota {
  return {
    async take(appId, userId) {
      const { day, nextMidnight } = plusEightDay(deps.clock.now());
      const limit = await dailyMax(deps, appId);
      // A counter failure rejects (the tool answers tool_failed): never let the lookup through.
      const count = await deps.counter.incr(
        `explain_order_no:${appId}:${userId}:${day}`,
        nextMidnight,
      );
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('order number quota: the counter answered no count');
      }
      return count <= limit;
    },
  };
}

export function orderNoDailyMaxDefault(): number {
  return 20;
}

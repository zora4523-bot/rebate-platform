// B2-15b: the four user-side pay order use cases (contract createPayOrder, getPayOrder,
// payOrderReturned, cancelPayOrder; 08 BR-PAY-01 ～ 05; task §9.4 ～ §9.9; rulings D10-236 ④,
// D10-245). The controllers (http/public/) only authenticate, take the parameters and call these;
// request-level idempotency (x-idempotent, subject u:<user_id>) is platform's.
//
// createPayOrder, in order:
//   switches and sellability (domain/sellability.ts) → 30901 data.reason;
//   one transaction: pg_advisory_xact_lock(hashtextextended('payment.biz:' || app_id || ':' ||
//   biz_type || ':' || biz_ref, 0)), then re-read the object's PENDING / PAID orders:
//     PAID → 30902 data.pay_order_id; PENDING on another channel, or PENDING with closing=true →
//     20902 data.resource=pay_order; PENDING on the same channel → that order again (fresh launch
//     parameters, launch_issued_at = now); none → INSERT PENDING (out_trade_no from
//     domain/out-trade-no.ts, amount and title from the registry, expire_at = now + ttl) and
//     commit before the channel is called;
//   every channel call writes a pay_query_attempts row (kind 'query', result 'prepay' / 'unknown');
//   unknown → 50306 data.pay_channel, the order stays PENDING; ok → launch_issued_at = now.
// Launch parameters never reach a log line; the order never carries a channel-side user id; no
// ledger posting happens here (payment/AGENTS.md rules 1, 6).
// NotImplemented skeleton (rule-test phase).
import type { DB } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock, JobQueue, RootLogger } from '../../platform/index.ts';
import type { PayChannelCode, PayUnavailableReason } from '../domain/types.ts';
import type { BizTypeRegistry } from './biz-registry.ts';
import type { PayChannelSet } from './pay-channel.ts';

/** The caller: from the access token, and the request's X-Platform. */
export interface PaySubject {
  readonly app_id: string;
  readonly user_id: string;
  readonly platform: string;
}

export interface PayOrderDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly queue: JobQueue;
  readonly channels: PayChannelSet;
  readonly registry: BizTypeRegistry;
  readonly logger: RootLogger;
}

export type PayFailure =
  | { readonly code: 30901; readonly data: { readonly reason: PayUnavailableReason } }
  | { readonly code: 30902; readonly data: { readonly pay_order_id: string } }
  | { readonly code: 20902; readonly data: { readonly resource: 'pay_order' } }
  | { readonly code: 50306; readonly data: { readonly pay_channel: PayChannelCode } }
  | { readonly code: 30701 };

export type PayResult<T> = { readonly code: 0; readonly data: T } | PayFailure;

/** POST /v1/pay/orders. */
export function createPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  input: Schema<'CreatePayOrderRequest'>,
): Promise<PayResult<Schema<'CreatePayOrderData'>>> {
  void deps;
  void subject;
  void input;
  throw new Error('NotImplemented: createPayOrder');
}

/** GET /v1/pay/orders/{pay_order_id}: the owner's order only, else 30701. */
export function getPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Schema<'PayOrder'>>> {
  void deps;
  void subject;
  void payOrderId;
  throw new Error('NotImplemented: getPayOrder');
}

/**
 * POST …/returned: a PENDING order gets one immediate query job (queue pay, name order.query,
 * singletonKey order.query:<pay_order_id>:returned, same transaction); any other status answers
 * success without a job. Data {}.
 */
export function payOrderReturned(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Record<string, never>>> {
  void deps;
  void subject;
  void payOrderId;
  throw new Error('NotImplemented: payOrderReturned');
}

/**
 * POST …/cancel: under the business object lock, a PENDING order with closing=false gets
 * closing=true, close_reason='user_cancel' and one close job (queue pay, name order.close,
 * singletonKey order.close:<pay_order_id>); not PENDING → 20902 resource pay_order. The channel
 * query and close are the job's (B2-15d).
 */
export function cancelPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Schema<'PayOrder'>>> {
  void deps;
  void subject;
  void payOrderId;
  throw new Error('NotImplemented: cancelPayOrder');
}

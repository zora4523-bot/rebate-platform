// B2-15f: the console's reads of payment's own tables (pay_orders, pay_refunds, pay_query_attempts,
// pay_anomalies; db/schema.sql), for GET /admin/v1/pay-orders, GET /admin/v1/pay-orders/{id} and
// GET /admin/v1/pay-anomalies. Read only, always scoped by app_id. Only the columns the contract
// shows are selected: pay_query_attempts' request / response bodies and pay_anomalies' evidence
// (which may carry channel-side payer identifiers, BR-PAY-08 ④) are never read here.
// No logging, no clock: instants come in as values.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { PayOrderRow } from './pay-order-store.ts';
import type { PayRefundRow, PayRefundsTable } from './pay-refund-store.ts';

/** The filters of the pay order list (contract listAdminPayOrders), combined with AND. */
export interface PayOrderFilter {
  readonly appId: string;
  readonly status?: string;
  readonly payChannel?: string;
  readonly bizType?: string;
  readonly userId?: string;
  readonly outTradeNo?: string;
  readonly needsManual?: boolean;
  /** created_at ≥ createdFrom (inclusive; ISO 8601 with offset, read as timestamptz). */
  readonly createdFrom?: string;
  /** created_at < createdTo (exclusive; ISO 8601 with offset, read as timestamptz). */
  readonly createdTo?: string;
}

/** An ISO 8601 instant with offset as a timestamptz parameter. */
function instant(text: string) {
  return sql<Date>`${text}::timestamptz`;
}

function filteredOrders(db: Kysely<DB>, filter: PayOrderFilter) {
  let query = db.selectFrom('pay_orders').where('app_id', '=', filter.appId);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  if (filter.payChannel !== undefined) query = query.where('pay_channel', '=', filter.payChannel);
  if (filter.bizType !== undefined) query = query.where('biz_type', '=', filter.bizType);
  if (filter.userId !== undefined) query = query.where('user_id', '=', filter.userId);
  if (filter.outTradeNo !== undefined) query = query.where('out_trade_no', '=', filter.outTradeNo);
  if (filter.needsManual !== undefined) {
    query = query.where('needs_manual', '=', filter.needsManual);
  }
  if (filter.createdFrom !== undefined) {
    query = query.where('created_at', '>=', instant(filter.createdFrom));
  }
  if (filter.createdTo !== undefined) {
    query = query.where('created_at', '<', instant(filter.createdTo));
  }
  return query;
}

/** The number of pay orders the filter matches. */
export async function countPayOrders(db: Kysely<DB>, filter: PayOrderFilter): Promise<number> {
  const row = await filteredOrders(db, filter)
    .select((eb) => eb.fn.countAll<bigint | string>().as('total'))
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/** One page of the matching pay orders, created_at descending (id descending on a tie). */
export async function pagePayOrders(
  db: Kysely<DB>,
  filter: PayOrderFilter,
  offset: number,
  limit: number,
): Promise<PayOrderRow[]> {
  return filteredOrders(db, filter)
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** The pay order's refunds (target_type pay_order), newest first. */
export async function refundsOfOrder(
  db: Kysely<DB>,
  appId: string,
  payOrderId: string,
): Promise<PayRefundRow[]> {
  return db
    .$extendTables<{ pay_refunds: PayRefundsTable }>()
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', appId)
    .where('target_type', '=', 'pay_order')
    .where('target_id', '=', payOrderId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

/** The summary of one channel request (pay_query_attempts without its bodies). */
export interface AttemptSummary {
  readonly kind: string;
  readonly result: string | null;
  readonly at: Date;
}

/**
 * The newest `limit` channel requests of the pay order and of its refunds, newest first. The
 * request and response bodies are not selected.
 */
export async function attemptsOfOrder(
  db: Kysely<DB>,
  appId: string,
  payOrderId: string,
  limit: number,
): Promise<AttemptSummary[]> {
  return db
    .selectFrom('pay_query_attempts')
    .select(['kind', 'result', 'at'])
    .where('app_id', '=', appId)
    .where((eb) =>
      eb.or([
        eb('pay_order_id', '=', payOrderId),
        eb(
          'pay_refund_id',
          'in',
          eb
            .selectFrom('pay_refunds')
            .select('pay_refunds.id')
            .where('pay_refunds.app_id', '=', appId)
            .where('pay_refunds.target_type', '=', 'pay_order')
            .where('pay_refunds.target_id', '=', payOrderId),
        ),
      ]),
    )
    .orderBy('at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

/** The contract's columns of a pay_anomalies row (evidence is left out). */
export type PayAnomalyListRow = Pick<
  Selectable<DB['pay_anomalies']>,
  | 'id'
  | 'pay_channel'
  | 'channel_trade_no'
  | 'out_trade_no'
  | 'pay_order_id'
  | 'amount_fen'
  | 'refunded_fen'
  | 'status'
  | 'created_at'
>;

/** The filter of the pay anomaly list (contract listAdminPayAnomalies). */
export interface PayAnomalyFilter {
  readonly appId: string;
  readonly payChannel?: string;
}

function filteredAnomalies(db: Kysely<DB>, filter: PayAnomalyFilter) {
  let query = db.selectFrom('pay_anomalies').where('app_id', '=', filter.appId);
  if (filter.payChannel !== undefined) query = query.where('pay_channel', '=', filter.payChannel);
  return query;
}

export async function countPayAnomalies(db: Kysely<DB>, filter: PayAnomalyFilter): Promise<number> {
  const row = await filteredAnomalies(db, filter)
    .select((eb) => eb.fn.countAll<bigint | string>().as('total'))
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/** One page of the app's anomaly receipts, created_at descending (id descending on a tie). */
export async function pagePayAnomalies(
  db: Kysely<DB>,
  filter: PayAnomalyFilter,
  offset: number,
  limit: number,
): Promise<PayAnomalyListRow[]> {
  return filteredAnomalies(db, filter)
    .select([
      'id',
      'pay_channel',
      'channel_trade_no',
      'out_trade_no',
      'pay_order_id',
      'amount_fen',
      'refunded_fen',
      'status',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

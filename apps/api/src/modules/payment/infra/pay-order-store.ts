// B2-15b: Kysely access to pay_orders and pay_query_attempts (payment's own tables, db/schema.sql;
// the couli_app role may INSERT and UPDATE only the columns listed in the grants, and the trigger
// pay_orders_reject_immutable_update keeps out_trade_no, amount_fen, pay_channel, biz_type,
// biz_ref and user_id as written). Every write runs on the caller's transaction; the business
// object lock (task §9.4) is taken here too. No logging, no clock: instants come in as values.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

export type PayOrderRow = Selectable<DB['pay_orders']>;

/** The business object a pay order pays for, inside one app. */
export interface BizObjectKey {
  readonly appId: string;
  readonly bizType: string;
  readonly bizRef: string;
}

/** The advisory lock key of a business object (task §9.4; the rule tests use the same text). */
export function bizObjectLockKey(key: BizObjectKey): string {
  return `payment.biz:${key.appId}:${key.bizType}:${key.bizRef}`;
}

/**
 * Takes the business object's transaction-level advisory lock (pg_advisory_xact_lock over
 * hashtextextended of the key, seed 0): every create / re-issue / cancel of the object's orders
 * serialises here, then re-reads (BR-PAY-02 CAS 口径).
 */
export async function lockBizObject(trx: Transaction<DB>, key: BizObjectKey): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${bizObjectLockKey(key)}::text, 0))`.execute(
    trx,
  );
}

/** The object's PENDING / PAID orders (at most one by the partial unique index; CLOSED ones excluded). */
export async function findOpenOrders(
  trx: Transaction<DB>,
  key: BizObjectKey,
): Promise<PayOrderRow[]> {
  return trx
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('biz_type', '=', key.bizType)
    .where('biz_ref', '=', key.bizRef)
    .where('status', 'in', ['PENDING', 'PAID'])
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** One order of this app, this user (the owner only: someone else's order is as if absent). */
export async function findOwnOrder(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  userId: string,
  payOrderId: string,
): Promise<PayOrderRow | undefined> {
  return handle
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('id', '=', payOrderId)
    .executeTakeFirst();
}

export async function findOrderById(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  payOrderId: string,
): Promise<PayOrderRow | undefined> {
  return handle
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', payOrderId)
    .executeTakeFirst();
}

export interface NewPayOrder {
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
  readonly bizType: string;
  readonly bizRef: string;
  readonly payChannel: string;
  readonly amountFen: bigint;
  readonly outTradeNo: string;
  readonly expireAt: Date;
  readonly now: Date;
}

/** The 落单 of a new order: PENDING, nothing issued yet. */
export async function insertPendingOrder(
  trx: Transaction<DB>,
  order: NewPayOrder,
): Promise<PayOrderRow> {
  return trx
    .insertInto('pay_orders')
    .values({
      id: order.id,
      app_id: order.appId,
      user_id: order.userId,
      biz_type: order.bizType,
      biz_ref: order.bizRef,
      pay_channel: order.payChannel,
      amount_fen: order.amountFen,
      refunded_fen: 0n,
      status: 'PENDING',
      out_trade_no: order.outTradeNo,
      channel_trade_no: null,
      expire_at: order.expireAt,
      launch_issued_at: null,
      closing: false,
      needs_manual: false,
      paid_at: null,
      closed_at: null,
      close_reason: null,
      created_at: order.now,
      updated_at: order.now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Records that launch parameters were issued now: a CAS on «PENDING, not closing and expire_at
 * after now», so an order that entered the close flow or expired meanwhile is left alone (0 rows →
 * the caller answers 20902 and returns no launch, BR-PAY-03).
 */
export async function markLaunchIssued(
  trx: Transaction<DB>,
  appId: string,
  payOrderId: string,
  now: Date,
): Promise<PayOrderRow | undefined> {
  return trx
    .updateTable('pay_orders')
    .set({ launch_issued_at: now, updated_at: now })
    .where('app_id', '=', appId)
    .where('id', '=', payOrderId)
    .where('status', '=', 'PENDING')
    .where('closing', '=', false)
    .where('expire_at', '>', now)
    .returningAll()
    .executeTakeFirst();
}

/**
 * The user's cancel: a CAS on «PENDING and not closing» → closing with close_reason user_cancel.
 * expire_at is not a condition: an expired PENDING order can still be cancelled (the close job
 * then confirms the state with the channel, B2-15d).
 */
export async function markClosing(
  trx: Transaction<DB>,
  appId: string,
  payOrderId: string,
  closeReason: 'user_cancel',
  now: Date,
): Promise<PayOrderRow | undefined> {
  return trx
    .updateTable('pay_orders')
    .set({ closing: true, close_reason: closeReason, updated_at: now })
    .where('app_id', '=', appId)
    .where('id', '=', payOrderId)
    .where('status', '=', 'PENDING')
    .where('closing', '=', false)
    .returningAll()
    .executeTakeFirst();
}

export interface NewQueryAttempt {
  readonly id: string;
  readonly appId: string;
  readonly payOrderId: string;
  readonly kind: 'query';
  /** Flat JSON summaries; never the launch parameters themselves. */
  readonly request: Readonly<Record<string, string | number | boolean | null>>;
  readonly response: Readonly<Record<string, string | number | boolean | null>>;
  readonly result: string;
  readonly at: Date;
}

/** One channel call as a pay_query_attempts row (payment/AGENTS.md rule 7: 外部写先落单). */
export async function insertQueryAttempt(
  trx: Transaction<DB>,
  attempt: NewQueryAttempt,
): Promise<void> {
  await trx
    .insertInto('pay_query_attempts')
    .values({
      id: attempt.id,
      app_id: attempt.appId,
      pay_order_id: attempt.payOrderId,
      pay_refund_id: null,
      kind: attempt.kind,
      request: sql`${JSON.stringify(attempt.request)}::jsonb`,
      response: sql`${JSON.stringify(attempt.response)}::jsonb`,
      result: attempt.result,
      at: attempt.at,
      created_at: attempt.at,
    })
    .execute();
}

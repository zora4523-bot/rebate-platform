// B2-15b / B2-15c: Kysely access to payment's own tables (pay_orders, pay_query_attempts, and from
// B2-15c pay_notifications, pay_anomalies, pay_fulfillments; db/schema.sql;
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

// ---------------------------------------------------------------------------------------------
// B2-15c: the pay result judgement's rows (pay_orders PO2, pay_notifications, pay_anomalies,
// pay_fulfillments; payment's own tables, db/schema.sql; grants: INSERT on each, UPDATE of the
// columns named below). pay_notifications and pay_query_attempts are append-only (triggers).

/** Our order of an out_trade_no on a channel inside an app (BR-PAY-04 核对 ②; unique per app). */
export async function findOrderByOutTradeNo(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  payChannel: string,
  outTradeNo: string,
): Promise<PayOrderRow | undefined> {
  return handle
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('pay_channel', '=', payChannel)
    .where('out_trade_no', '=', outTradeNo)
    .executeTakeFirst();
}

/** The object's PAID order (at most one by pay_orders_open_biz_key). */
export async function findPaidOrder(
  trx: Transaction<DB>,
  key: BizObjectKey,
): Promise<PayOrderRow | undefined> {
  return trx
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('biz_type', '=', key.bizType)
    .where('biz_ref', '=', key.bizRef)
    .where('status', '=', 'PAID')
    .executeTakeFirst();
}

/**
 * PO2 as a CAS on «PENDING» (BR-PAY-02: 影响 0 行即并发冲突): PAID, paid_at and the channel's
 * trade number, closing cleared. The caller holds the business object lock and has re-read the
 * order; 0 rows → undefined, and the caller rolls its transaction back.
 */
export async function markPaid(
  trx: Transaction<DB>,
  appId: string,
  payOrderId: string,
  channelTradeNo: string,
  now: Date,
): Promise<PayOrderRow | undefined> {
  return trx
    .updateTable('pay_orders')
    .set({
      status: 'PAID',
      paid_at: now,
      channel_trade_no: channelTradeNo,
      closing: false,
      updated_at: now,
    })
    .where('app_id', '=', appId)
    .where('id', '=', payOrderId)
    .where('status', '=', 'PENDING')
    .returningAll()
    .executeTakeFirst();
}

export interface NewPayNotification {
  readonly id: string;
  readonly appId: string;
  readonly payChannel: string;
  readonly notifyId: string;
  readonly outTradeNo: string | null;
  readonly outRefundNo: string | null;
  /** The field cipher's ciphertext of the original (UTF-8 bytes of the `v1.…` text). */
  readonly payloadCipher: Buffer;
  readonly verifyResult: 'ok';
  readonly handleResult: string;
  readonly receivedAt: Date;
}

/**
 * Keeps one verified notification (insert only, BR-PAY-04 「通知原文只插入留存」). The same
 * (app_id, pay_channel, notify_id) a second time inserts nothing (the channel re-sent the same
 * notification); returns whether this call inserted the row.
 */
export async function insertNotification(
  trx: Transaction<DB>,
  row: NewPayNotification,
): Promise<boolean> {
  const result = await trx
    .insertInto('pay_notifications')
    .values({
      id: row.id,
      app_id: row.appId,
      pay_channel: row.payChannel,
      notify_id: row.notifyId,
      out_trade_no: row.outTradeNo,
      out_refund_no: row.outRefundNo,
      payload_cipher: row.payloadCipher,
      verify_result: row.verifyResult,
      handle_result: row.handleResult,
      received_at: row.receivedAt,
      created_at: row.receivedAt,
    })
    .onConflict((oc) => oc.columns(['app_id', 'pay_channel', 'notify_id']).doNothing())
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/**
 * Whether a kept notification of the same merchant order already ended with this handle result:
 * the mismatch alert is raised once per order and reason (BR-PAY-04 细则 「告警按单去重」).
 */
export async function hasNotificationResult(
  trx: Transaction<DB>,
  appId: string,
  payChannel: string,
  outTradeNo: string,
  handleResult: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('pay_notifications')
    .select('id')
    .where('app_id', '=', appId)
    .where('pay_channel', '=', payChannel)
    .where('out_trade_no', '=', outTradeNo)
    .where('handle_result', '=', handleResult)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export type PayAnomalyRow = Selectable<DB['pay_anomalies']>;

export interface NewPayAnomaly {
  readonly id: string;
  readonly appId: string;
  readonly payChannel: string;
  readonly channelTradeNo: string;
  readonly outTradeNo: string | null;
  readonly payOrderId: string | null;
  readonly amountFen: bigint;
  /** Flat JSON of ids, numbers as text and the channel state; never the original or a payer id. */
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Registers an anomaly receipt (BR-PAY-05 ④) once per (app_id, pay_channel, channel_trade_no):
 * a repeat inserts nothing. The row is read back afterwards either way (a concurrent insert that
 * committed first is seen by the read; one that rolled back let this insert through).
 */
export async function registerAnomalyRow(
  trx: Transaction<DB>,
  row: NewPayAnomaly,
): Promise<{ readonly anomaly: PayAnomalyRow; readonly created: boolean }> {
  const result = await trx
    .insertInto('pay_anomalies')
    .values({
      id: row.id,
      app_id: row.appId,
      pay_channel: row.payChannel,
      channel_trade_no: row.channelTradeNo,
      out_trade_no: row.outTradeNo,
      pay_order_id: row.payOrderId,
      amount_fen: row.amountFen,
      refunded_fen: 0n,
      evidence: sql`${JSON.stringify(row.evidence)}::jsonb`,
      status: 'open',
    })
    .onConflict((oc) => oc.columns(['app_id', 'pay_channel', 'channel_trade_no']).doNothing())
    .executeTakeFirst();
  const anomaly = await trx
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', row.appId)
    .where('pay_channel', '=', row.payChannel)
    .where('channel_trade_no', '=', row.channelTradeNo)
    .executeTakeFirstOrThrow();
  return { anomaly, created: (result.numInsertedOrUpdatedRows ?? 0n) > 0n };
}

export type PayFulfillmentRow = Selectable<DB['pay_fulfillments']>;

export interface FulfillmentWrite {
  readonly id: string;
  readonly key: BizObjectKey;
  readonly state: 'none' | 'active' | 'revoked';
  readonly lastPayOrderId: string | null;
  readonly refundedFen: bigint;
  readonly appliedAt: Date;
}

/**
 * Sets the business object's entitlement as recomputed (D10-168: set, never added or subtracted):
 * one row per (app_id, biz_type, biz_ref), version + 1 on every run, applied_at = now.
 */
export async function upsertFulfillment(
  trx: Transaction<DB>,
  write: FulfillmentWrite,
): Promise<PayFulfillmentRow> {
  return trx
    .insertInto('pay_fulfillments')
    .values({
      id: write.id,
      app_id: write.key.appId,
      biz_type: write.key.bizType,
      biz_ref: write.key.bizRef,
      state: write.state,
      last_pay_order_id: write.lastPayOrderId,
      refunded_fen: write.refundedFen,
      version: 1n,
      applied_at: write.appliedAt,
      created_at: write.appliedAt,
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'biz_type', 'biz_ref']).doUpdateSet({
        state: write.state,
        last_pay_order_id: write.lastPayOrderId,
        refunded_fen: write.refundedFen,
        version: sql`${sql.ref('pay_fulfillments.version')} + 1`,
        applied_at: write.appliedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

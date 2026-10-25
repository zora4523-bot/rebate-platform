// B2-15e: Kysely access to the refund side of payment's tables (pay_refunds, the refund columns of
// pay_orders / pay_anomalies, pay_query_attempts rows of a refund; db/schema.sql and migration
// 0088_pay-refunds-note-idempotency-operator.sql). The couli_app role may INSERT pay_refunds and
// UPDATE only status, channel_refund_no, succeeded_at and failed_at; the trigger
// pay_refunds_reject_immutable_update keeps out_refund_no, amount_fen, target_type and target_id
// as written, and `note` has no UPDATE grant at all (D10-350: written by the creating INSERT only).
// Every write runs on the caller's transaction; the anomaly lock (the business object of a refund
// of an anomaly receipt) is taken here too. No logging, no clock: instants come in as values.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { PayRefundReason, PayRefundTargetType } from '../domain/types.ts';

/**
 * pay_refunds with the `note` column of D10-350 (migration 0088). Transitional, explicitly local:
 * packages/db/src/db.gen.ts is a generated file and gains the column with `pnpm db:snapshot` on
 * the test machine; until then the row type is widened here and nowhere else. Once the snapshot
 * carries `note`, this intersection is redundant and harmless.
 */
export type PayRefundsTable = DB['pay_refunds'] & { note: string | null };

type RefundTables = { pay_refunds: PayRefundsTable };

export type PayRefundRow = Selectable<PayRefundsTable>;

/** The handle with the widened pay_refunds table (schema and plugins unchanged). */
function refundsOf<H extends Kysely<DB> | Transaction<DB>>(handle: H) {
  return handle.$extendTables<RefundTables>();
}

/** The advisory lock key of an anomaly receipt: the business object of its refunds. */
export function anomalyLockKey(appId: string, payAnomalyId: string): string {
  return `payment.anomaly:${appId}:${payAnomalyId}`;
}

/**
 * Takes the anomaly receipt's transaction-level advisory lock (the same form as the business object
 * lock of a pay order, infra/pay-order-store.ts): every refund creation and every refund result of
 * the receipt serialises here, then re-reads (BR-PAY-06 ③ 先取业务对象级的锁).
 */
export async function lockAnomaly(
  trx: Transaction<DB>,
  appId: string,
  payAnomalyId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${anomalyLockKey(appId, payAnomalyId)}::text, 0))`.execute(
    trx,
  );
}

export type PayAnomalyRow = Selectable<DB['pay_anomalies']>;

export async function findAnomalyById(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  payAnomalyId: string,
): Promise<PayAnomalyRow | undefined> {
  return handle
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', payAnomalyId)
    .executeTakeFirst();
}

export async function findRefundById(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  payRefundId: string,
): Promise<PayRefundRow | undefined> {
  return refundsOf(handle)
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', payRefundId)
    .executeTakeFirst();
}

/** Our refund of an out_refund_no inside an app (BR-PAY-06 ④ 核对 ②; unique per app). */
export async function findRefundByOutRefundNo(
  handle: Kysely<DB> | Transaction<DB>,
  appId: string,
  outRefundNo: string,
): Promise<PayRefundRow | undefined> {
  return refundsOf(handle)
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', appId)
    .where('out_refund_no', '=', outRefundNo)
    .executeTakeFirst();
}

/**
 * The amount a target's refunds hold: Σ amount_fen of its SUCCESS and PROCESSING refunds
 * (BR-PAY-06 ③ 「已成功 + 处理中」; a FAILED refund holds nothing). Read under the target's lock.
 */
export async function heldRefundFen(
  trx: Transaction<DB>,
  appId: string,
  targetType: PayRefundTargetType,
  targetId: string,
): Promise<bigint> {
  const result = await sql<{ held: string }>`
    SELECT coalesce(sum(amount_fen), 0)::text AS held FROM app.pay_refunds
    WHERE app_id = ${appId} AND target_type = ${targetType} AND target_id = ${targetId}
      AND status IN ('SUCCESS', 'PROCESSING')`.execute(trx);
  return BigInt(result.rows[0]?.held ?? '0');
}

export interface NewPayRefund {
  readonly id: string;
  readonly appId: string;
  readonly targetType: PayRefundTargetType;
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly outRefundNo: string;
  readonly amountFen: bigint;
  readonly reasonCode: PayRefundReason;
  /** D10-350: kept as given, at most 200 characters (the contract schema checks it); null without one. */
  readonly note: string | null;
  /** admin_users.id of the operator (pay_refunds.operator). */
  readonly operator: string;
  /** The injected Clock's instant (never the database's now()). */
  readonly now: Date;
}

/** The 落单 of a refund: PROCESSING (RF1), nothing sent to the channel yet. */
export async function insertRefund(
  trx: Transaction<DB>,
  refund: NewPayRefund,
): Promise<PayRefundRow> {
  return refundsOf(trx)
    .insertInto('pay_refunds')
    .values({
      id: refund.id,
      app_id: refund.appId,
      target_type: refund.targetType,
      target_id: refund.targetId,
      idempotency_key: refund.idempotencyKey,
      out_refund_no: refund.outRefundNo,
      amount_fen: refund.amountFen,
      reason_code: refund.reasonCode,
      note: refund.note,
      status: 'PROCESSING',
      channel_refund_no: null,
      operator: refund.operator,
      created_at: refund.now,
      succeeded_at: null,
      failed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * RF2 as a CAS on «PROCESSING» (BR-PAY-06 ⑤ 退款单状态 CAS): SUCCESS, succeeded_at and the
 * channel's refund number when reported. 0 rows → undefined, the caller rolls back.
 */
export async function markRefundSucceeded(
  trx: Transaction<DB>,
  appId: string,
  payRefundId: string,
  channelRefundNo: string | null,
  now: Date,
): Promise<PayRefundRow | undefined> {
  return refundsOf(trx)
    .updateTable('pay_refunds')
    .set({
      status: 'SUCCESS',
      succeeded_at: now,
      ...(channelRefundNo === null ? {} : { channel_refund_no: channelRefundNo }),
    })
    .where('app_id', '=', appId)
    .where('id', '=', payRefundId)
    .where('status', '=', 'PROCESSING')
    .returningAll()
    .executeTakeFirst();
}

/** RF3 as a CAS on «PROCESSING»: FAILED and failed_at; the held amount is free again. */
export async function markRefundFailed(
  trx: Transaction<DB>,
  appId: string,
  payRefundId: string,
  channelRefundNo: string | null,
  now: Date,
): Promise<PayRefundRow | undefined> {
  return refundsOf(trx)
    .updateTable('pay_refunds')
    .set({
      status: 'FAILED',
      failed_at: now,
      ...(channelRefundNo === null ? {} : { channel_refund_no: channelRefundNo }),
    })
    .where('app_id', '=', appId)
    .where('id', '=', payRefundId)
    .where('status', '=', 'PROCESSING')
    .returningAll()
    .executeTakeFirst();
}

/**
 * refunded_fen of a PAID order grows by a succeeded refund (BR-PAY-06 ③ 支付单状态不因退款改变，另记
 * refunded_fen); the CHECK refunded_fen <= amount_fen is the last line. 0 rows → undefined.
 */
export async function addOrderRefundedFen(
  trx: Transaction<DB>,
  appId: string,
  payOrderId: string,
  amountFen: bigint,
  now: Date,
): Promise<Selectable<DB['pay_orders']> | undefined> {
  return trx
    .updateTable('pay_orders')
    .set({
      refunded_fen: sql<bigint>`refunded_fen + ${amountFen.toString()}::bigint`,
      updated_at: now,
    })
    .where('app_id', '=', appId)
    .where('id', '=', payOrderId)
    .where('status', '=', 'PAID')
    .returningAll()
    .executeTakeFirst();
}

/**
 * refunded_fen of an anomaly receipt grows by a succeeded refund; once everything received is
 * back, status becomes `refunded` (D10-236 ①). 0 rows → undefined.
 */
export async function addAnomalyRefundedFen(
  trx: Transaction<DB>,
  appId: string,
  payAnomalyId: string,
  amountFen: bigint,
): Promise<PayAnomalyRow | undefined> {
  const amount = amountFen.toString();
  return trx
    .updateTable('pay_anomalies')
    .set({
      refunded_fen: sql<bigint>`refunded_fen + ${amount}::bigint`,
      status: sql<string>`CASE WHEN refunded_fen + ${amount}::bigint >= amount_fen THEN 'refunded' ELSE status END`,
    })
    .where('app_id', '=', appId)
    .where('id', '=', payAnomalyId)
    .returningAll()
    .executeTakeFirst();
}

export interface NewRefundAttempt {
  readonly id: string;
  readonly appId: string;
  readonly payRefundId: string;
  readonly kind: 'refund' | 'refund_query';
  /** Flat JSON summaries; never a channel-side user identifier. */
  readonly request: Readonly<Record<string, string | number | boolean | null>>;
  readonly response: Readonly<Record<string, string | number | boolean | null>>;
  readonly result: string;
  readonly at: Date;
}

/** One channel call of a refund as a pay_query_attempts row (payment/AGENTS.md rule 7). */
export async function insertRefundAttempt(
  trx: Transaction<DB>,
  attempt: NewRefundAttempt,
): Promise<void> {
  await trx
    .insertInto('pay_query_attempts')
    .values({
      id: attempt.id,
      app_id: attempt.appId,
      pay_order_id: null,
      pay_refund_id: attempt.payRefundId,
      kind: attempt.kind,
      request: sql`${JSON.stringify(attempt.request)}::jsonb`,
      response: sql`${JSON.stringify(attempt.response)}::jsonb`,
      result: attempt.result,
      at: attempt.at,
      created_at: attempt.at,
    })
    .execute();
}

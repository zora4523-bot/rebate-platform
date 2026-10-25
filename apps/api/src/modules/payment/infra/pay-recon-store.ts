// B2-15j: the reconciliation's reads of payment's own tables (pay_orders, pay_refunds and, for the
// channel of a refund, pay_anomalies; db/schema.sql). Read only, always scoped by app_id; the
// reconciliation writes nothing here (anomaly rows go through infra/pay-order-store.ts
// registerAnomalyRow, vouchers and recon diffs through ledger's port). pay_anomalies' evidence is
// never read. No logging, no clock: the bill day comes in as the [start, end) texts of
// @couli/domain chinaDayRange.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { PayOrderRow } from './pay-order-store.ts';

/** An ISO 8601 instant with offset as a timestamptz parameter. */
function instant(text: string) {
  return sql<Date>`${text}::timestamptz`;
}

/** The PAID orders of one channel paid inside [start, end) (the bill day at +08:00). */
export async function paidOrdersOfDay(
  db: Kysely<DB>,
  appId: string,
  payChannel: string,
  start: string,
  end: string,
): Promise<PayOrderRow[]> {
  return db
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('pay_channel', '=', payChannel)
    .where('status', '=', 'PAID')
    .where('paid_at', '>=', instant(start))
    .where('paid_at', '<', instant(end))
    .orderBy('paid_at')
    .orderBy('id')
    .execute();
}

/** A refund as the reconciliation compares it, with the channel of its target. */
export interface ReconRefundRow {
  readonly id: string;
  readonly out_refund_no: string;
  readonly amount_fen: bigint;
  readonly status: string;
  readonly target_type: string;
  readonly target_id: string;
  /** The target's pay_channel (the refund row carries none); null when the target is missing. */
  readonly pay_channel: string | null;
  /** Our RF2 instant (null unless SUCCESS). */
  readonly succeeded_at: Date | null;
}

/** pay_refunds with the pay_channel of its pay order or anomaly receipt, inside one app. */
function refundsWithChannel(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('pay_refunds as r')
    .leftJoin('pay_orders as o', (join) =>
      join
        .onRef('o.app_id', '=', 'r.app_id')
        .onRef('o.id', '=', 'r.target_id')
        .on('r.target_type', '=', 'pay_order'),
    )
    .leftJoin('pay_anomalies as a', (join) =>
      join
        .onRef('a.app_id', '=', 'r.app_id')
        .onRef('a.id', '=', 'r.target_id')
        .on('r.target_type', '=', 'pay_anomaly'),
    )
    .select([
      'r.id',
      'r.out_refund_no',
      'r.amount_fen',
      'r.status',
      'r.target_type',
      'r.target_id',
      'r.succeeded_at',
    ])
    .select((eb) => eb.fn.coalesce('o.pay_channel', 'a.pay_channel').as('pay_channel'))
    .where('r.app_id', '=', appId);
}

function reconRefund(row: {
  readonly id: string;
  readonly out_refund_no: string;
  readonly amount_fen: bigint;
  readonly status: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly pay_channel: string | null;
  readonly succeeded_at: Date | null;
}): ReconRefundRow {
  return {
    id: row.id,
    out_refund_no: row.out_refund_no,
    amount_fen: row.amount_fen,
    status: row.status,
    target_type: row.target_type,
    target_id: row.target_id,
    pay_channel: row.pay_channel,
    succeeded_at: row.succeeded_at,
  };
}

/** Our refund of an out_refund_no inside an app (unique per app), with its target's channel. */
export async function findReconRefund(
  db: Kysely<DB>,
  appId: string,
  outRefundNo: string,
): Promise<ReconRefundRow | undefined> {
  const row = await refundsWithChannel(db, appId)
    .where('r.out_refund_no', '=', outRefundNo)
    .executeTakeFirst();
  return row === undefined ? undefined : reconRefund(row);
}

/**
 * The SUCCESS refunds of one channel (by their target's channel: pay orders and anomaly receipts
 * alike) that succeeded inside [start, end) (the bill day at +08:00).
 */
export async function succeededRefundsOfDay(
  db: Kysely<DB>,
  appId: string,
  payChannel: string,
  start: string,
  end: string,
): Promise<ReconRefundRow[]> {
  const rows = await refundsWithChannel(db, appId)
    .where('r.status', '=', 'SUCCESS')
    .where('r.succeeded_at', '>=', instant(start))
    .where('r.succeeded_at', '<', instant(end))
    .where((eb) =>
      eb.or([eb('o.pay_channel', '=', payChannel), eb('a.pay_channel', '=', payChannel)]),
    )
    .orderBy('r.succeeded_at')
    .orderBy('r.id')
    .execute();
  return rows.map(reconRefund);
}

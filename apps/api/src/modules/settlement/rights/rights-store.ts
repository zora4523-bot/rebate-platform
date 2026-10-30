// B2-04l: the rows settlement's rights command and R11 admin hold / unhold write, all on the
// caller's transaction (the order_key advisory lock is already held). settlement owns order_rights
// and the rebate columns of orders (hold, hold_reason, rights_pending, row_version / updated_at;
// BR-FUND-01). Always scoped by app_id, naming schema app.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type OrderRightsRow = Selectable<DB['order_rights']>;

export interface RightsKey {
  readonly appId: string;
  readonly orderId: string;
  readonly type: string;
  /** null matches null (the dedupe key is NULLS NOT DISTINCT, K-2). */
  readonly platformRightsNo: string | null;
}

/** The stored row of a K-2 key, locked FOR UPDATE; undefined when none. */
export async function findRights(
  trx: Transaction<DB>,
  key: RightsKey,
): Promise<OrderRightsRow | undefined> {
  let query = trx
    .withSchema('app')
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('order_id', '=', key.orderId)
    .where('type', '=', key.type);
  query =
    key.platformRightsNo === null
      ? query.where('platform_rights_no', 'is', null)
      : query.where('platform_rights_no', '=', key.platformRightsNo);
  return query.forUpdate().executeTakeFirst();
}

export interface RightsInsert extends RightsKey {
  readonly source: string;
  readonly status: string;
  readonly amountFen: bigint | null;
  readonly deductionFen: bigint | null;
  readonly occurredAt: Date;
  readonly now: Date;
}

/**
 * Inserts one order_rights row; ON CONFLICT on the K-2 key does nothing. Returns the new id, or
 * null when the key already exists (the unique index decides, never a second row).
 */
export async function insertRights(
  trx: Transaction<DB>,
  row: RightsInsert,
): Promise<string | null> {
  const id = randomUUID();
  const inserted = await trx
    .withSchema('app')
    .insertInto('order_rights')
    .values({
      id,
      app_id: row.appId,
      order_id: row.orderId,
      source: row.source,
      type: row.type,
      status: row.status,
      amount_fen: row.amountFen,
      deduction_commission_fen: row.deductionFen,
      occurred_at: row.occurredAt,
      platform_rights_no: row.platformRightsNo,
      created_at: row.now,
      updated_at: row.now,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted?.id ?? null;
}

export interface RightsResult {
  readonly status: string;
  readonly amountFen: bigint | null;
  readonly deductionFen: bigint | null;
  readonly occurredAt: Date;
  readonly now: Date;
}

/** The result of a stored record, in place (same id), CAS on (status, row_version). */
export async function updateRightsResult(
  trx: Transaction<DB>,
  stored: OrderRightsRow,
  result: RightsResult,
): Promise<boolean> {
  const updated = await trx
    .withSchema('app')
    .updateTable('order_rights')
    .set({
      status: result.status,
      amount_fen: result.amountFen,
      deduction_commission_fen: result.deductionFen,
      occurred_at: result.occurredAt,
      row_version: stored.row_version + 1,
      updated_at: result.now,
    })
    .where('app_id', '=', stored.app_id)
    .where('id', '=', stored.id)
    .where('status', '=', stored.status)
    .where('row_version', '=', stored.row_version)
    .executeTakeFirst();
  return (updated.numUpdatedRows ?? 0n) === 1n;
}

/**
 * BR-FUND-06 / 08: WAIT_COMMISSION rows closed as SUCCEEDED once the clawback was written (only
 * `rightsId` when given, else every WAIT_COMMISSION row of the order). Returns the rows closed.
 */
export async function closeWaitingRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  rightsId: string | null,
  at: Date,
): Promise<bigint> {
  let query = trx
    .withSchema('app')
    .updateTable('order_rights')
    .set((eb) => ({
      status: 'SUCCEEDED',
      row_version: eb('row_version', '+', 1),
      updated_at: at,
    }))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION');
  if (rightsId !== null) query = query.where('id', '=', rightsId);
  const result = await query.executeTakeFirst();
  return result.numUpdatedRows ?? 0n;
}

/** Whether some order_rights row of the order still waits for the union commission. */
export async function hasWaitingRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export interface OrderCasKey {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
  readonly row_version: number;
}

/** R11: hold / hold_reason, CAS on (rebate_status, row_version, hold); rebate_status unchanged. */
export async function casHold(
  trx: Transaction<DB>,
  key: OrderCasKey & { readonly hold: boolean },
  set: { readonly hold: boolean; readonly hold_reason: string | null },
  at: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      hold: set.hold,
      hold_reason: set.hold_reason,
      row_version: key.row_version + 1,
      updated_at: at,
    })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .where('hold', '=', key.hold)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}

/** One rebate history row of an admin R11 (source admin; settlement owns order_status_history). */
export async function insertAdminRebateHistory(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string; readonly rebate_status: string },
  event: 'HOLD' | 'UNHOLD',
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_status_history')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      field: 'rebate',
      from_status: order.rebate_status,
      event,
      to_status: order.rebate_status,
      source: 'admin',
      at,
    })
    .execute();
}

// B1-09l: the SQL of the console's hold / unhold (tables orders and order_sync_pending, both owned
// by orders). Read only: hold, hold_reason and row_version are written by settlement through
// B1-09c's rebate port, the audit by admin's writer. Always scoped by app_id, naming schema app.
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';

export interface OrderLockTarget {
  readonly platform: string;
  readonly sub_order_id: string;
}

/** The sub-order key of the app's order (immutable), read before the lock; undefined if none. */
export async function readOrderLockTarget(
  db: Kysely<DB>,
  appId: string,
  orderId: string,
): Promise<OrderLockTarget | undefined> {
  return db
    .withSchema('app')
    .selectFrom('orders')
    .select(['platform', 'sub_order_id'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
}

/** The whole orders row, reread FOR UPDATE; the caller already holds lockOrderKey in trx. */
export async function rereadOrderForUpdate(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<Selectable<DB['orders']> | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * K-7: whether the sub-order (app, platform, sub_order_id; whatever its order_id) has a BR-FUND-02
 * UNMAPPED_STATUS pending record with status=open. Read under the sub-order lock.
 */
export async function hasOpenUnmappedPending(
  trx: Transaction<DB>,
  appId: string,
  target: OrderLockTarget,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_sync_pending')
    .select('id')
    .where('app_id', '=', appId)
    .where('platform', '=', target.platform)
    .where('sub_order_id', '=', target.sub_order_id)
    .where('reason', '=', 'UNMAPPED_STATUS')
    .where('status', '=', 'open')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

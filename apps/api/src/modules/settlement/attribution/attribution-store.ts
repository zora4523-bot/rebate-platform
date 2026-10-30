// B2-04la：R3 / R3b 的订单行 CAS。只写 settlement 拥有的列：rebate_status、locked、settle_period、
// received_synced_at，以及 row_version / updated_at（BR-FUND-01；02 §18）。user_id、user_basis 与
// 返利历史由 orders 在端口之后写。调用方已在本事务里取得子订单 advisory 锁。
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type OrderRow = Selectable<DB['orders']>;

export interface AttributionSet {
  readonly rebate_status?: string;
  readonly settle_period?: string;
  readonly received_synced_at?: Date;
}

/**
 * UPDATE … SET …, locked = true, row_version = v + 1 WHERE app_id AND order_id AND attr_at
 * AND rebate_status = :from AND row_version = :v AND locked = false；返回是否命中一行。
 */
export async function casAttribute(
  trx: Transaction<DB>,
  before: Pick<OrderRow, 'app_id' | 'order_id' | 'attr_at' | 'rebate_status' | 'row_version'>,
  set: AttributionSet,
  now: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({ ...set, locked: true, row_version: before.row_version + 1, updated_at: now })
    .where('app_id', '=', before.app_id)
    .where('order_id', '=', before.order_id)
    .where('attr_at', '=', before.attr_at)
    .where('rebate_status', '=', before.rebate_status)
    .where('row_version', '=', before.row_version)
    .where('locked', '=', false)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

// B1-08h（BR-ATTR-01 并发；02 §18）：同一子订单的同步、找回通过、管理员变更、记账共用一把
// 事务级 advisory 锁，键文本 = 'orders.order_key:' + orderKey(platform, sub_order_id)；不按 app 或
// 联盟账号分锁。锁随事务提交或回滚释放。
import type { DB } from '@couli/db';
import { orderKey } from '@couli/domain';
import { sql, type Transaction } from 'kysely';

export function orderLockKeyText(platform: string, subOrderId: string): string {
  return `orders.order_key:${orderKey(platform, subOrderId)}`;
}

/** Must be the first statement of the transaction that reads and writes this sub-order. */
export async function lockOrderKey(
  trx: Transaction<DB>,
  platform: string,
  subOrderId: string,
): Promise<void> {
  const text = orderLockKeyText(platform, subOrderId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${text}, 0))`.execute(trx);
}

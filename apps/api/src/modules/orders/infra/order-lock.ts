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

/** B1-10b（BR-ATTR-17、BR-ATTR-19）：同一用户的找回受理串行执行，键文本按 (app_id, user_id)。 */
export function claimUserLockKeyText(appId: string, userId: string): string {
  return `orders.claim_user:${appId}:${userId}`;
}

/** Taken before any count of the claim acceptance is read; released with the transaction. */
export async function lockClaimUser(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  const text = claimUserLockKeyText(appId, userId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${text}, 0))`.execute(trx);
}

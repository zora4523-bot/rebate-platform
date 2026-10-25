// B1-10f：后台未归因订单指派写入的 SQL（orders 的归属列、order_status_history、order_assignments、
// 同子订单他人待审找回子项的查找）。每条查询都在给定事务上执行并显式写 schema app。orders 只写 user_id、
// user_basis=admin、来源四列与 paid_at_source（locked、rebate_status 归 settlement 端口）；order_assignments
// 只插入。找回子项与 claims 的写入复用 claim-review-store.ts。
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { OrderAttributionWrite, ReviewItemRow } from './claim-review-store.ts';

/**
 * BR-ATTR-20 ③ 中 orders 自己的列：user_id、user_basis=admin（来源回填四列、paid_at_source 按调用方给的）。
 * 只在 settlement 端口之后调用，返回端口写后的 rebate_status 与 locked（供历史与守卫，不另读）。
 */
export async function writeAdminAttribution(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string },
  write: OrderAttributionWrite,
  now: Date,
): Promise<{ readonly rebate_status: string; readonly locked: boolean }> {
  const row = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      ...write,
      user_basis: 'admin',
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
      updated_at: now,
    })
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('user_id', 'is', null)
    .returning(['rebate_status', 'locked'])
    .executeTakeFirst();
  if (row === undefined) throw new Error('orders: assigned order changed under its row lock');
  return row;
}

/** 管理员指派的返利状态历史：field=rebate、event=ADMIN_REASSIGN、source=admin（只插入）。 */
export async function insertAdminRebateHistory(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string },
  fromStatus: string,
  toStatus: string,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_status_history')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      field: 'rebate',
      from_status: fromStatus,
      event: 'ADMIN_REASSIGN',
      to_status: toStatus,
      source: 'admin',
      at,
    })
    .execute();
}

export interface AssignmentInsert {
  readonly id: string;
  readonly appId: string;
  readonly orderId: string;
  readonly toUserId: string;
  readonly reason: string;
  readonly adminId: string;
  readonly now: Date;
}

/** order_assignments（迁移 0084）：一次指派一行，source=admin，只插入。 */
export async function insertAdminAssignment(
  trx: Transaction<DB>,
  row: AssignmentInsert,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_assignments')
    .values({
      id: row.id,
      app_id: row.appId,
      order_id: row.orderId,
      to_user_id: row.toUserId,
      source: 'admin',
      reason: row.reason,
      admin_id: row.adminId,
      created_at: row.now,
    })
    .execute();
}

/** 同一 App、同平台、同子订单号上申请人不是 `userId` 的待审子项（任何 claim），按 id 升序。 */
export async function pendingItemsOfOthers(
  trx: Transaction<DB>,
  appId: string,
  order: { readonly platform: string; readonly sub_order_id: string },
  userId: string,
): Promise<ReviewItemRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select([
      'id',
      'claim_id',
      'applicant_user_id',
      'platform',
      'sub_order_id',
      'order_id',
      'decision',
      'row_version',
    ])
    .where('app_id', '=', appId)
    .where('platform', '=', order.platform)
    .where('sub_order_id', '=', order.sub_order_id)
    .where('decision', 'is', null)
    .where('applicant_user_id', '<>', userId)
    .orderBy('id')
    .execute();
}

// B1-10k：后台找回审核写入的 SQL（claims、claim_items 的状态写入，orders 的归属列与 order_status_history）。
// 每条查询都在给定句柄上执行并显式写 schema app。claims / claim_items 的 status / decision 只在这里写，
// 取值来自调用方用生成的 transitionClaim() / transitionClaimItem() 得出的结果；orders 只写 user_id、
// user_basis、来源四列与 paid_at_source（locked、rebate_status 归 settlement 端口）。
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

export interface ReviewClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
}

export interface ReviewItemRow {
  readonly id: string;
  readonly claim_id: string;
  readonly applicant_user_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly order_id: string;
  readonly decision: string | null;
  readonly row_version: number;
}

const ITEM_COLUMNS = [
  'id',
  'claim_id',
  'applicant_user_id',
  'platform',
  'sub_order_id',
  'order_id',
  'decision',
  'row_version',
] as const;

/** 本 App 的 claim（不加锁；锁内另行重读）。 */
export async function findReviewClaim(
  db: Kysely<DB>,
  appId: string,
  claimId: string,
): Promise<ReviewClaimRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('claims')
    .select(['id', 'user_id', 'status'])
    .where('app_id', '=', appId)
    .where('id', '=', claimId)
    .executeTakeFirst();
}

/** 本 App、属于该 claim 的子项。 */
export async function findReviewItem(
  db: Kysely<DB>,
  appId: string,
  claimId: string,
  itemId: string,
): Promise<ReviewItemRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('claim_items')
    .select(ITEM_COLUMNS)
    .where('app_id', '=', appId)
    .where('claim_id', '=', claimId)
    .where('id', '=', itemId)
    .executeTakeFirst();
}

/** BR-ATTR-20 ①：取子订单锁之后 SELECT … FOR UPDATE 重读订单整行。 */
export async function lockOrderRow(
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

/** 同一 App、同平台、同子订单号上除 `itemId` 外的待审子项（任何申请人、任何 claim）。 */
export async function pendingSiblingItems(
  trx: Transaction<DB>,
  appId: string,
  item: Pick<ReviewItemRow, 'id' | 'platform' | 'sub_order_id'>,
): Promise<ReviewItemRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select(ITEM_COLUMNS)
    .where('app_id', '=', appId)
    .where('platform', '=', item.platform)
    .where('sub_order_id', '=', item.sub_order_id)
    .where('decision', 'is', null)
    .where('id', '<>', item.id)
    .orderBy('id')
    .execute();
}

/** 一条语句按 id 升序 FOR UPDATE 锁住全部受影响的 claims（防汇总竞态与跨 claim 互等）。 */
export async function lockClaims(
  trx: Transaction<DB>,
  appId: string,
  claimIds: readonly string[],
): Promise<ReviewClaimRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('claims')
    .select(['id', 'user_id', 'status'])
    .where('app_id', '=', appId)
    .where('id', 'in', [...claimIds])
    .orderBy('id')
    .forUpdate()
    .execute();
}

/** 锁内重读被审子项。 */
export async function readItem(
  trx: Transaction<DB>,
  appId: string,
  itemId: string,
): Promise<ReviewItemRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select(ITEM_COLUMNS)
    .where('app_id', '=', appId)
    .where('id', '=', itemId)
    .executeTakeFirst();
}

export interface ItemDecisionWrite {
  readonly appId: string;
  readonly itemId: string;
  readonly claimId: string;
  readonly expectedRowVersion: number;
  readonly decision: string;
  readonly rejectReason: string | null;
  readonly decidedBy: string | null;
  readonly now: Date;
}

/** 待审 → 决定（CAS：decision 为空且 row_version 未变）；返回是否写中一行。 */
export async function writeItemDecision(
  trx: Transaction<DB>,
  write: ItemDecisionWrite,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('claim_items')
    .set({
      decision: write.decision,
      reject_reason: write.rejectReason,
      decided_by: write.decidedBy,
      decided_at: write.now,
      updated_at: write.now,
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
    })
    .where('app_id', '=', write.appId)
    .where('id', '=', write.itemId)
    .where('claim_id', '=', write.claimId)
    .where('decision', 'is', null)
    .where('row_version', '=', write.expectedRowVersion)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** 该 claim 全部子项的决定（含未决 null）。 */
export async function claimDecisions(
  trx: Transaction<DB>,
  appId: string,
  claimId: string,
): Promise<(string | null)[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select('decision')
    .where('app_id', '=', appId)
    .where('claim_id', '=', claimId)
    .execute();
  return rows.map((row) => row.decision);
}

export interface ClaimWrite {
  readonly appId: string;
  readonly claimId: string;
  /** 锁内读到的状态（CAS）。 */
  readonly fromStatus: string;
  /** 汇总后的新状态；未全部已决时不给。 */
  readonly status?: string;
  /** 本次审核说明（只写被审子项所属 claim）。 */
  readonly reason?: string;
  readonly now: Date;
}

/** 写 claim 的汇总状态与 / 或最新说明；CAS 落空即抛错（行已锁，不应发生），整事务回滚。 */
export async function writeClaim(trx: Transaction<DB>, write: ClaimWrite): Promise<void> {
  const result = await trx
    .withSchema('app')
    .updateTable('claims')
    .set({
      ...(write.status === undefined ? {} : { status: write.status }),
      ...(write.reason === undefined ? {} : { reason: write.reason }),
      updated_at: write.now,
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
    })
    .where('app_id', '=', write.appId)
    .where('id', '=', write.claimId)
    .where('status', '=', write.fromStatus)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('orders: claim changed under its row lock');
}

export interface OrderAttributionWrite {
  readonly user_id: string;
  readonly source_match?: string | null;
  readonly link_id?: string | null;
  readonly source_scene?: string | null;
  readonly agent_session_id?: string | null;
  readonly paid_at_source?: string;
}

/**
 * BR-ATTR-20 ③ 中 orders 自己的列：user_id、user_basis=claim（来源回填四列、paid_at_source 按调用方给的）。
 * 只在 settlement 端口之后调用，返回端口写后的 rebate_status 与 locked（供历史与守卫，不另读）。
 */
export async function writeClaimAttribution(
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
      user_basis: 'claim',
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
      updated_at: now,
    })
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('user_id', 'is', null)
    .returning(['rebate_status', 'locked'])
    .executeTakeFirst();
  if (row === undefined) throw new Error('orders: claimed order changed under its row lock');
  return row;
}

/** 找回通过的返利状态历史：field=rebate、source=claim（只插入）。 */
export async function insertClaimRebateHistory(
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
      event: 'CLAIM_APPROVED',
      to_status: toStatus,
      source: 'claim',
      at,
    })
    .execute();
}

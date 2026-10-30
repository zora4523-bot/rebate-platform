// B1-08zc：平台恢复检测（BR-FUND-22）的只读查询——进入当前返利状态的那条 order_status_history（field='rebate'）。
// 返利历史由 settlement / 后台写，本模块只读（同一张表的 platform 行才由本模块写）。在调用方已取得子订单 advisory
// 锁的事务里运行。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface RebateEntryRow {
  readonly id: bigint;
  readonly event: string;
}

/** 最近一条迁入 rebateStatus 的返利历史（id 最大者）；没有返回 undefined。 */
export async function readRebateEntry(
  trx: Transaction<DB>,
  order: { app_id: string; order_id: string },
  rebateStatus: string,
): Promise<RebateEntryRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('order_status_history')
    .select(['id', 'event'])
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('field', '=', 'rebate')
    .where('to_status', '=', rebateStatus)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

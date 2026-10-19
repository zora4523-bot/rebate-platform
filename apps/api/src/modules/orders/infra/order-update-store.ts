// B1-08i：已有订单同步更新的 CAS UPDATE（BR-FUND-01；规划/02 §18）。只写 orders 模块拥有的同步列与
// 未归因时的归属列与来源四列（B1-08j）、paid_at_source（B1-08k）；返利列（rebate_status、hold*、rights_pending、locked、booked_*、settle_period、reason*）、
// 身份列与 attr_at 不在可写集合里。调用方已在本事务里取得子订单 advisory 锁。
import type { DB } from '@couli/db';
import type { Selectable, Transaction, Updateable } from 'kysely';
import type { OrderSyncColumns } from '../domain/update-plan.ts';

type OrderRow = Selectable<DB['orders']>;

export type OrderUpdateSet = OrderSyncColumns &
  Pick<Updateable<DB['orders']>, 'platform_status'> & {
    readonly row_version: number;
    readonly updated_at: Date;
    readonly pid?: string | null;
    readonly relation_id?: string | null;
    readonly sub_union_id?: string | null;
    readonly custom_params?: string | null;
    readonly user_id?: string;
    readonly user_basis?: 'param';
    /** 来源回填（B1-08j，BR-ATTR-15）：只在本次写 user_id 且库内 source_match 为空时随同写入。 */
    readonly source_match?: 'exact' | 'product' | 'shop' | 'none';
    readonly link_id?: string | null;
    readonly source_scene?: string | null;
    readonly agent_session_id?: string | null;
    /** paid_at 来源（B1-08k，BR-CALC-11）：只在本次跨入快照资格、且库内为空时随同写入，已有值不覆盖。 */
    readonly paid_at_source?: 'platform' | 'platform_modified' | 'observed';
  };

export interface CasGuards {
  /** 本次按未归因写入参数：WHERE 另加 user_id IS NULL。 */
  readonly unattributed: boolean;
  /** 本次写 user_id（R3a / R3b）：WHERE 另加 locked = false。 */
  readonly attributing: boolean;
  /** 本次写来源四列（B1-08j）：WHERE 另加 source_match IS NULL（已有来源不覆盖）。 */
  readonly backfilling?: boolean;
}

/**
 * UPDATE … WHERE order_id AND attr_at AND app_id AND row_version = :v AND platform_status = :from；
 * 返回是否命中一行（0 行 = 并发冲突，由调用方重读后重新判定）。
 */
export async function casUpdateOrder(
  trx: Transaction<DB>,
  current: Pick<OrderRow, 'order_id' | 'attr_at' | 'app_id' | 'row_version' | 'platform_status'>,
  set: OrderUpdateSet,
  guards: CasGuards,
): Promise<boolean> {
  let query = trx
    .withSchema('app')
    .updateTable('orders')
    .set(set)
    .where('order_id', '=', current.order_id)
    .where('attr_at', '=', current.attr_at)
    .where('app_id', '=', current.app_id)
    .where('row_version', '=', current.row_version)
    .where('platform_status', '=', current.platform_status);
  if (guards.unattributed) query = query.where('user_id', 'is', null);
  if (guards.attributing) query = query.where('locked', '=', false);
  if (guards.backfilling === true) query = query.where('source_match', 'is', null);
  const result = await query.executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

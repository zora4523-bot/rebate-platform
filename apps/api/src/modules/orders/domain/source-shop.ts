// B1-08p：来源回填的店铺维度（BR-ATTR-15 ③ shop；编排补充口径 1～6）。纯判定，不做 I/O：
// - 报文店铺三态（UnionOrder.shop_id）：undefined = 该平台订单报文没有店铺字段（③ 不适用）；
//   null = 有店铺字段但本条为空 / 非法；非空字符串 = 店铺标识。空串按 null。
// - orders.shop_id 只由空写为非空，不覆盖已写值（口径 2）。
// - 待补（口径 4）：回填结果为 none、报文店铺显式为空且库内也为空、推广位场景已知 → 四列保持 NULL，
//   不写 none；之后某次同步带来店铺时重跑一次（口径 5）。BR-ATTR-15「订单已经有 source_match（包括 none）
//   之后，同步更新不再重跑回填」——source_match 仍为 NULL 即尚未终结。
// - 08 BR-ATTR-15 没有重试次数与放弃条件（待编排裁定 1、2）：不计数；触发条件只有「同步带来此前缺失的
//   店铺」一种，因此每单至多重跑一次；店铺一直不来就一直保持 NULL，不按时间或状态改写为 none（口径 6）。
import type { UnionOrder } from '../../union/index.ts';
import type { OrderSourceMatch } from './source-backfill.ts';

/** B1-08p 编排补充口径 4：在既有回填函数之外判定是否保留四列 NULL。 */
export interface DeferOrderSourceInput {
  readonly source: OrderSourceMatch;
  /** 本次报文的店铺（三态，见文件头）。 */
  readonly incomingShopId: string | null | undefined;
  /** 库内 orders.shop_id（首次入库为 null）。 */
  readonly currentShopId: string | null;
  /** 订单推广位的 pid_scene；null = 场景未知（② / ③ 本就不跨场景，照 D10-60 写 none）。 */
  readonly pidScene: string | null;
}

/**
 * 回填结果为 none，且报文店铺显式为空（键存在）、库内店铺也为空、推广位场景已知 → true（四列保持
 * NULL、待补）。exact / product / shop 命中、平台无店铺字段（undefined）、店铺已知、场景未知 → false。
 */
export function shouldDeferOrderSource(input: DeferOrderSourceInput): boolean {
  return (
    input.source.source_match === 'none' &&
    (input.incomingShopId === null || input.incomingShopId === '') &&
    input.currentShopId === null &&
    input.pidScene !== null
  );
}

/** 报文店铺的三态（见文件头）；空串按 null。 */
export function incomingShopId(order: Pick<UnionOrder, 'shop_id'>): string | null | undefined {
  const value = order.shop_id;
  if (value === undefined) return undefined;
  return value === null || value === '' ? null : value;
}

/** 口径 2：库内为空、本次报文非空才写（只空 → 非空）。返回要写入的值；不写为 null。 */
export function shopIdToWrite(
  currentShopId: string | null,
  incoming: string | null | undefined,
): string | null {
  return currentShopId === null && typeof incoming === 'string' && incoming !== ''
    ? incoming
    : null;
}

export interface ShopRetryInput {
  /** 库内 orders.user_id。 */
  readonly userId: string | null;
  /** 库内 orders.source_match。 */
  readonly sourceMatch: string | null;
  readonly currentShopId: string | null;
  readonly incomingShopId: string | null | undefined;
}

/**
 * 口径 5：已归属、来源尚未终结（source_match IS NULL）、库内无店铺、本次报文带来店铺 → 重跑一次回填
 * （是否注入了 sources 由调用方判定）。重跑时店铺已知，结果一定终结（exact / product / shop / none）。
 */
export function shouldRetryOrderSource(input: ShopRetryInput): boolean {
  return (
    input.userId !== null &&
    input.sourceMatch === null &&
    shopIdToWrite(input.currentShopId, input.incomingShopId) !== null
  );
}

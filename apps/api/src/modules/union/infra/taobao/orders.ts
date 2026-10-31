// 淘宝订单（B1-04f，D10-486 ② / D10-488 / D10-504 补）：经大淘客 GET /api/tb-service/get-order-details
// （version v1.0.0）取 publisher_order_dto，映射到 UnionOrder（平台无关字段 + TaobaoOrderFields）。
// 骨架只定端口与告警形状；请求参数、切窗、游标、映射与推广位过滤由实现补上。
// - 请求：queryType 由 OrderQueryOpt.timeBasis 定（update 4 默认 / pay 2 / settle 3 / create 1）；
//   startTime / endTime 是北京时间「YYYY-MM-DD HH:MM:SS」，窗口 > 3 小时按 3 小时顺序切窗；
//   每窗首页不带 positionIndex，续页原样带上一页的 position_index，直到 has_next 为 false；
//   pageSize 100，orderScene 1。每个上游请求经 CallCtx.gateUpstream 各取一个配额（per_request）。
// - 一次 listOrders 取一个上游页；nextCursor 是不透明串，承载当前窗起点与 position_index。
// - 推广位过滤：只留 adzone_id 属于 TaobaoOrderSlotReader 给出的推广位（PID 最后一段）的订单；
//   清单为空 → 不发请求、返回空页并告警一次；端口未注入 → adapter_unimplemented。
import type { CallCtx } from '../../domain/types.ts';

/**
 * Every Taobao PID (`mm_<memberid>_<siteid>_<adzoneid>`) the platform registered in union_pids for
 * the caller, retired ones included (orders placed before retirement are still ours). Called with
 * the listOrders CallCtx, at most once per call and before any upstream request.
 */
export type TaobaoOrderSlotReader = (ctx: CallCtx) => Promise<readonly string[]>;

/**
 * Order warnings. None carries an order number, an amount, a PID or credentials:
 * - taobao_order_field_invalid: one optional field was missing or invalid and became null
 *   (`field` is the upstream field name);
 * - taobao_order_row_skipped: a row lacked a required field (trade_id, alipay_total_price,
 *   pub_share_pre_fee) or had it invalid, and was left out (`field` names it);
 * - taobao_order_foreign_slot: once per upstream page that held orders of other promotion slots
 *   (`count` is how many were left out);
 * - taobao_order_no_slots: the slot reader gave no usable PID; nothing was requested.
 */
export type TaobaoOrderWarningEvent =
  | 'taobao_order_field_invalid'
  | 'taobao_order_row_skipped'
  | 'taobao_order_foreign_slot'
  | 'taobao_order_no_slots';

export interface TaobaoOrderWarning {
  readonly event: TaobaoOrderWarningEvent;
  readonly field?: string;
  readonly count?: number;
}

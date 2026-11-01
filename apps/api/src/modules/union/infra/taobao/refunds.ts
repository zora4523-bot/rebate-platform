// 淘宝维权（B1-04z，D10-486 ③ / D10-488 ② / D10-491）：经大淘客 GET /api/tb-service/get-order-refund
// （version v1.0.0；文档写 POST，实测 POST → HTTP 439，按 GET）取维权明细，映射到 UnionRefund。
// - 请求：queryType 由 RefundQueryOpt.timeBasis 定（refund_created 1 / settle 2 / refund_finished 3 /
//   create 4 / update 5 默认）；create / update 的起点早于北京时间 2022-12-20 00:00:00 → invalid_dto；
//   startTime / endTime 北京时间「YYYY-MM-DD HH:MM:SS」（同 orders.ts 换算），窗口 > 3 小时按 3 小时
//   顺序切窗；每窗首页不带 positionIndex，续页带上一页的 position_index；pageSize 100、memberType 4、
//   orderScene 1。一次 listRefunds 取一个上游页（listRefundsMetering = per_request，经
//   ctx.gateUpstream），nextCursor 是不透明串（与订单游标互不通用）。has_next 为 true 而 position_index
//   缺失 / 空 / 与本次相同 → upstream_unavailable。归档 kind = order。
// - 映射（data.result[]）：order_id = tb_trade_id；refund_id = refund_suit_id；base_refund_fen =
//   tk_commission_fee_refund − tk_commission_alimm_refund_fee − tk_commission_agent_refund_fee；
//   subsidy_refund_fen = tk_subsidy_fee_refund − tk_subsidy_alimm_refund_fee −
//   tk_subsidy_agent_refund_fee；refund_fen = base_refund_fen。各金额先按 BR-CALC-26 yuanStrToFen 单独
//   取分（JSON 数字取原文），再相减。必需字段缺失 / 非法 → 跳过该条并告警；任一差为负 → 跳过并告警。
// - 维权记录没有推广位字段：union 侧不过滤，原样返回；是否凑狸订单由 orders / funds 按已入库订单匹配。
// TODO(规划/11 §4.5): 明细字段按文档写（录制窗口内 0 条），待大淘客维权录制复核 — blocked on 大淘客录制
// TODO(w1): 扣哪几项服务费待与 specs/attribution.md 的淘宝 N 映射对齐（该文件尚无淘宝映射）

/**
 * Refund warnings. None carries an order number, a refund id or an amount:
 * - taobao_refund_row_skipped: a required field (tb_trade_id, refund_suit_id or one of the six
 *   tk_*_refund amounts) was missing or invalid; `field` is the upstream field name;
 * - taobao_refund_negative: base_refund_fen or subsidy_refund_fen came out negative (`field`
 *   names which); the refund was left out;
 * - taobao_refund_field_invalid: an optional field was invalid and became null (`field`).
 */
export type TaobaoRefundWarningEvent =
  | 'taobao_refund_row_skipped'
  | 'taobao_refund_negative'
  | 'taobao_refund_field_invalid';

export interface TaobaoRefundWarning {
  readonly event: TaobaoRefundWarningEvent;
  readonly field?: string;
}

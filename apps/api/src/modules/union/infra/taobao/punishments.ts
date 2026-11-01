// 淘宝违规（B1-04z，D10-486 ③ / D10-488 ②③）：经大淘客 GET /api/tb-service/get-foul-order-list
// （version v1.0.0）取违规订单，映射到 UnionPunish。
// - 请求：startTime（北京时间「YYYY-MM-DD HH:MM:SS」，由窗口起点换算，同 orders.ts）+ span（天）；
//   窗口按 30 天一段顺序切，每段 span = min(30, 该段剩余时长向上取整到天)；段内 pageNo 从 1 起逐页，
//   累计条数达到该页的 total_count 即该段结束。一页没有记录而累计仍不足 total_count、或 total_count
//   缺失 / 非法 → upstream_unavailable。一次 listPunishments 取一个上游页（listPunishmentsMetering =
//   per_request，经 ctx.gateUpstream），nextCursor 是不透明串。归档 kind = order。上游只能查近 30 天，
//   本地不另做裁剪。
// - 映射（data.results[]）：order_id = tb_trade_id；punishment_id = `<tb_trade_id>:<settle_month>`；
//   deduction_fen = null（违规无扣款字段，按 BR-FUND 走 PUNISH 全额扣回）；punish_status /
//   violation_type / settle_month 原样字符串（JSON 数字取原文）。tb_trade_id 或 settle_month 缺失 /
//   非法 → 跳过该条并告警。
// - 推广位过滤：只留 tk_adzone_id 属于 orderSlots 给出的推广位（PID 最后一段，含 retired，与 orders.ts
//   同口径）的记录；别家每页计数告警一次；清单为空 → 不发请求、返回空页并告警一次；订单源或推广位
//   端口未注入 → adapter_unimplemented。
// TODO(规划/11 §4.5): 明细字段按文档写（录制窗口内 0 条），待大淘客违规录制复核 — blocked on 大淘客录制

/**
 * Punishment warnings. None carries an order number, an amount or a PID:
 * - taobao_punish_row_skipped: tb_trade_id or settle_month was missing or invalid (`field`);
 * - taobao_punish_foreign_slot: once per upstream page that held records of other promotion
 *   slots (`count` is how many were left out);
 * - taobao_punish_no_slots: the slot reader gave no usable PID; nothing was requested.
 */
export type TaobaoPunishWarningEvent =
  | 'taobao_punish_row_skipped'
  | 'taobao_punish_foreign_slot'
  | 'taobao_punish_no_slots';

export interface TaobaoPunishWarning {
  readonly event: TaobaoPunishWarningEvent;
  readonly field?: string;
  readonly count?: number;
}

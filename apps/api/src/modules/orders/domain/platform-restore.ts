// B1-08zc：订单平台恢复检测（08 BR-FUND-22）的纯判定部分。作废 / 扣回子订单被平台恢复（P9 回到非失效状态，
// 或佣金由 ≤0 / 空恢复为 >0），且 reason ∈ {REFUND, RIGHTS, COMMISSION_ZERO} 或进入当前返利状态的事件 ∈
// {PLATFORM_INVALID, INVALID_AFTER_SETTLE} 时，经端口登记一张 platform_restore 差错单；PUNISH / BLACKLIST 的只更新
// platform_status。一次作废 / 扣回（进入当前返利状态的那条 order_status_history 行）只出一张单。
// 差错单的 ref_id 与 dedupe_key 只在这里构造（settlement 的 P9 登记接线复用同一个 dedupe_key，单一出处）。

/** 触发：status = P9（INVALID → PAID / RECEIVED / SETTLED）；commission = 本次写入的佣金列由 ≤0 或空变为 >0。 */
export type PlatformRestoreTrigger = 'status' | 'commission';

/** 差错单 resolution（只作展示；ADMIN_RESTORE 处理时按 R12 / R13 重算）。 */
export type PlatformRestoreResolution = {
  /** orders.reason 原值（可为空）。 */
  readonly reason_code: string | null;
  /** 当前返利状态（VOID / CLAWED_BACK）。 */
  readonly rebate_status: string;
  readonly trigger: PlatformRestoreTrigger;
  /** 本次更新之后的 platform_status。 */
  readonly platform_status: string;
};

/**
 * 差错单的 dedupe_key：`platform_restore:{order_key}:{entry_id}`。entry_id 是进入当前返利状态的那条
 * order_status_history（field='rebate'）行的 id；重新作废产生新行，因而是新单。
 */
export function platformRestoreDedupeKey(orderKey: string, entryId: bigint): string {
  void orderKey;
  void entryId;
  throw new Error('NotImplemented: platformRestoreDedupeKey');
}

/** 差错单的 ref_id：`{order_key}#RESTORE#{entry_id}`（ref_type='order'）。 */
export function platformRestoreRefId(orderKey: string, entryId: bigint): string {
  void orderKey;
  void entryId;
  throw new Error('NotImplemented: platformRestoreRefId');
}

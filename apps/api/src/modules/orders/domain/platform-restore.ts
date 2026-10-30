// B1-08zc：订单平台恢复检测（08 BR-FUND-22）的纯判定部分。作废 / 扣回子订单被平台恢复（P9 回到非失效状态，
// 或佣金由 ≤0 / 空恢复为 >0），且 reason ∈ {REFUND, RIGHTS, COMMISSION_ZERO} 或进入当前返利状态的事件 ∈
// {PLATFORM_INVALID, INVALID_AFTER_SETTLE} 时，经端口登记一张 platform_restore 差错单；PUNISH / BLACKLIST 的只更新
// platform_status。一次作废 / 扣回（进入当前返利状态的那条 order_status_history 行）只出一张单。
// B1-08zd：佣金触发按有效佣金（结算佣金非空取它，否则取预估佣金）越过 0 判定，不按 platform_status 切换。
// 差错单的 ref_id 与 dedupe_key 只在这里构造（settlement 的 P9 登记接线复用同一个 dedupe_key，单一出处）。

/** 触发：status = P9（INVALID → PAID / RECEIVED / SETTLED）；commission = 有效佣金由 ≤0 或空变为 >0。 */
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

/** 前提 (i)：orders.reason 属这几类（08 BR-FUND-22）。PUNISH / BLACKLIST 等不在内。 */
const RESTORE_REASONS: ReadonlySet<string> = new Set(['REFUND', 'RIGHTS', 'COMMISSION_ZERO']);
/** 前提 (ii)：进入当前返利状态的那条 rebate 历史事件属这几类。 */
const RESTORE_ENTRY_EVENTS: ReadonlySet<string> = new Set([
  'PLATFORM_INVALID',
  'INVALID_AFTER_SETTLE',
]);
/** 只有作废 / 扣回的子订单才谈得上「被平台恢复」。 */
const RESTORABLE_REBATE: ReadonlySet<string> = new Set(['VOID', 'CLAWED_BACK']);
/** P9 的去向：INVALID 回到非失效状态。 */
const ACTIVE_PLATFORM: ReadonlySet<string> = new Set(['PAID', 'RECEIVED', 'SETTLED']);

/** 本次更新前后的平台状态与两列联盟佣金（after = 本次 UPDATE 写入后的值；未改即等于 before）。 */
export interface PlatformRestoreChange {
  readonly platformBefore: string;
  readonly platformAfter: string;
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleBefore: bigint | null;
  readonly settleAfter: bigint | null;
}

export interface PlatformRestoreSignal {
  readonly trigger: PlatformRestoreTrigger;
  /** 平台恢复后的联盟佣金（分）；只作差错单展示。 */
  readonly expectedFen: bigint;
}

/** 由空或 ≤0 变为严格 >0（恰好 0 不算恢复）。 */
function crossedPositive(before: bigint | null, after: bigint | null): boolean {
  return (before === null || before <= 0n) && after !== null && after > 0n;
}

/** 返利状态是否可能被平台恢复（VOID / CLAWED_BACK）；不是则无须读历史。 */
export function isRestorableRebate(rebateStatus: string): boolean {
  return RESTORABLE_REBATE.has(rebateStatus);
}

/**
 * 有效佣金（08 BR-CALC-02 取值阶段）：结算佣金非空时只取结算佣金，否则取预估佣金；两列都空为空。
 */
function effectiveCommission(est: bigint | null, settle: bigint | null): bigint | null {
  return settle !== null ? settle : est;
}

/**
 * 触发判定（B1-08zc 编排 9.2 第 2、4 条；B1-08zd 编排第 11 节）：status = P9（INVALID → PAID / RECEIVED /
 * SETTLED），金额取恢复后的有效佣金列（SETTLED 用结算佣金，否则预估佣金，空按 0）；commission = 本次更新使有效佣金
 * （结算佣金非空取它，否则取预估佣金）由空或 ≤0 变为 >0，与 platform_status 无关，金额取新的有效佣金。结算佣金非空时
 * 预估佣金的变化不触发。两者同时成立按 status。都不成立返回 null。
 */
export function detectPlatformRestore(change: PlatformRestoreChange): PlatformRestoreSignal | null {
  if (change.platformBefore === 'INVALID' && ACTIVE_PLATFORM.has(change.platformAfter)) {
    const effective = change.platformAfter === 'SETTLED' ? change.settleAfter : change.estAfter;
    return { trigger: 'status', expectedFen: effective ?? 0n };
  }
  const effBefore = effectiveCommission(change.estBefore, change.settleBefore);
  const effAfter = effectiveCommission(change.estAfter, change.settleAfter);
  if (crossedPositive(effBefore, effAfter) && effAfter !== null) {
    return { trigger: 'commission', expectedFen: effAfter };
  }
  return null;
}

/**
 * 前提判定（08 BR-FUND-22）：返利状态 VOID / CLAWED_BACK，且 reason ∈ {REFUND, RIGHTS, COMMISSION_ZERO}（支 i）
 * 或进入当前返利状态的事件 ∈ {PLATFORM_INVALID, INVALID_AFTER_SETTLE}（支 ii）。entryEvent 为 null 表示没有进入行。
 */
export function isPlatformRestoreEligible(input: {
  readonly rebateStatus: string;
  readonly reason: string | null;
  readonly entryEvent: string | null;
}): boolean {
  if (!RESTORABLE_REBATE.has(input.rebateStatus)) return false;
  if (input.reason !== null && RESTORE_REASONS.has(input.reason)) return true;
  return input.entryEvent !== null && RESTORE_ENTRY_EVENTS.has(input.entryEvent);
}

/**
 * 差错单的 dedupe_key：`platform_restore:{order_key}:{entry_id}`。entry_id 是进入当前返利状态的那条
 * order_status_history（field='rebate'）行的 id；重新作废产生新行，因而是新单。
 */
export function platformRestoreDedupeKey(orderKey: string, entryId: bigint): string {
  return `platform_restore:${orderKey}:${entryId.toString(10)}`;
}

/** 差错单的 ref_id：`{order_key}#RESTORE#{entry_id}`（ref_type='order'）。 */
export function platformRestoreRefId(orderKey: string, entryId: bigint): string {
  return `${orderKey}#RESTORE#${entryId.toString(10)}`;
}

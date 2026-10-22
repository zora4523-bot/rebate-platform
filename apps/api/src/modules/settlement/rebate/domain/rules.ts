// B2-04j：入账前返利迁移的纯判定（BR-FUND-01 R1–R7、BR-FUND-02、BR-FUND-03、BR-FUND-04 ②、BR-FUND-06、
// BR-FUND-07）。不读库、不读时钟；状态合法性只经生成的 transitionOrderRebate。
import { transitionOrderRebate, type OrderRebateEvent, type OrderRebateState } from '@couli/domain';

/** 订单原因码（orders.reason，BR-FUND-07 的 void 类编码）。 */
export type VoidReason = 'REFUND' | 'RIGHTS' | 'PUNISH' | 'BLACKLIST' | 'COMMISSION_ZERO';

/** R6 的作废事件 → 原因码（BR-FUND-07）。 */
export function voidReasonOf(event: OrderRebateEvent): VoidReason | null {
  switch (event) {
    case 'PLATFORM_INVALID':
      return 'REFUND';
    case 'RIGHTS_FULL':
      return 'RIGHTS';
    case 'PUNISH':
      return 'PUNISH';
    case 'BLACKLIST_HIT':
      return 'BLACKLIST';
    case 'BASE_ZERO':
      return 'COMMISSION_ZERO';
    default:
      return null;
  }
}

/** 入账前可迁移的状态（R6 的来源）。 */
export function isPrecredit(state: string): state is 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' {
  return state === 'UNATTRIBUTED' || state === 'ESTIMATED' || state === 'WAITING';
}

/** BR-FUND-06：hold 只能对 ESTIMATED / WAITING 设置（R11）。 */
export function isHoldable(state: string): state is 'ESTIMATED' | 'WAITING' {
  return state === 'ESTIMATED' || state === 'WAITING';
}

/** 已锁定订单（BR-FUND-01 细则「订单锁定」）：平台正向推进与重复上报不改变返利。 */
export function isLocked(state: string): state is 'VOID' | 'CREDITED' | 'CLAWED_BACK' {
  return state === 'VOID' || state === 'CREDITED' || state === 'CLAWED_BACK';
}

export function isRebateState(state: string): state is OrderRebateState {
  return isPrecredit(state) || isLocked(state);
}

/** BR-FUND-03：已归因且 platform_status ∈ {PAID, RECEIVED, SETTLED} 才有预估。 */
export function hasEstimate(platformStatus: string): boolean {
  return platformStatus === 'PAID' || platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

/**
 * BR-FUND-02 可入账事件已登记的平台（taobao、jd、pdd = 确认收货；meituan = 订单完成或核销）。P1 平台
 * （vip、douyin、eleme）未写入前不进入 WAITING。
 * TODO(规划/11 §4.2): 改为读 specs/creditable-events.yaml — blocked on 该文件尚未建立。
 */
export function isCreditablePlatform(platform: string): boolean {
  return platform === 'taobao' || platform === 'jd' || platform === 'pdd' || platform === 'meituan';
}

/** R4 的触发状态：平台已收货或已结算。 */
export function isReceivedOrSettled(platformStatus: string): boolean {
  return platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

/**
 * BR-FUND-07 / R6 基数归零分支：原基数为正、新基数为 0（null 表示未知，不视为 0）。结算佣金已到、
 * 平台处于定金期、或本次是从定金期进入付款（P2 / P14 的「首次 B_est」）时都不触发。
 */
export function isBaseZero(input: {
  readonly before: bigint | null;
  readonly after: bigint | null;
  readonly settleCommissionFen: bigint | null;
  readonly platformStatus: string;
  readonly fromPlatformStatus: string | null;
}): boolean {
  if (input.settleCommissionFen !== null) return false;
  if (input.platformStatus === 'DEPOSIT_PAID' || input.fromPlatformStatus === 'DEPOSIT_PAID') {
    return false;
  }
  return input.before !== null && input.before > 0n && input.after === 0n;
}

/** 本次报文的平台事件映射到 R6 的作废事件（P6 / P7 → 整单失效，P8 处罚 → PUNISH）；其他为 null。 */
export function reverseEventOf(
  sourceEvent: string | null,
  platformStatus: string,
): 'PLATFORM_INVALID' | 'PUNISH' | null {
  if (sourceEvent === 'PLATFORM_INVALID' || platformStatus === 'INVALID') return 'PLATFORM_INVALID';
  if (sourceEvent === 'PLATFORM_PUNISH') return 'PUNISH';
  return null;
}

export interface RebateStep {
  readonly from: OrderRebateState | null;
  readonly event: OrderRebateEvent;
  readonly to: OrderRebateState;
}

/** 按生成的迁移表求一步；表外返回 null。 */
export function step(from: OrderRebateState | null, event: OrderRebateEvent): RebateStep | null {
  const result = transitionOrderRebate(from, event);
  return result.ok ? { from, event, to: result.to } : null;
}

/** settle.period_basis.<platform> 的取值：未配置按默认 received_at；其他取值本任务不认。 */
export function periodBasisSupported(value: unknown): boolean {
  return value === undefined || value === null || value === 'received_at';
}

/** order_sync.unmapped_status_hold.enabled：默认 on，只有明确的 off 才关闭。 */
export function unmappedHoldEnabled(value: unknown): boolean {
  return !(value === false || value === 'false' || value === 'off');
}

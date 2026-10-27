// B2-11a: BR-WDR-29 审核风险标签 (规划/08 BR-WDR-29; task 9.3), the pure parts. risk_flags keeps
// the hit labels only, each {code, value, threshold}; ④⑤⑥ take their thresholds as parameters so
// BR-WDR-30 ⑧ (B2-11b) reuses them with its own alert thresholds. Ratios compare exactly
// (numerator × 10000 > threshold × denominator); value is the bp floored. Counts are integers,
// amounts bigint fen, ratios integer bp; arithmetic only through @couli/money.
// Rule tests: test/spec/payout/risk-flags/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import { mulDivCeil, mulDivFloor } from '@couli/money';

/** The labels computed at W1 (⑨ blacklist_hit is checked live, not here), in BR order. */
export type WithdrawRiskFlagCode =
  | 'first_withdrawal'
  | 'credited_today'
  | 'same_device_multi_account'
  | 'invalid_ratio_60d'
  | 'high_commission_ratio_60d'
  | 'withdraw_vs_received'
  | 'had_negative'
  | 'recon_diff'
  | 'payee_prev_other_user';

/**
 * true for ①②③⑦⑧⑩; bp for ④⑤⑥ (null for ⑥ with a zero denominator); for risk_calc_failed the
 * codes whose calculation failed, in BR order.
 */
export type WithdrawRiskFlagValue = boolean | number | null | readonly WithdrawRiskFlagCode[];

/** One element of withdrawals.risk_flags. */
export interface WithdrawRiskFlag {
  readonly code: WithdrawRiskFlagCode | 'risk_calc_failed';
  readonly value: WithdrawRiskFlagValue;
  readonly threshold: number | null;
}

/** ④ risk.withdraw.invalid_ratio_bp / invalid_min_count. */
export interface InvalidRatioThresholds {
  readonly invalid_ratio_bp: number;
  readonly invalid_min_count: number;
}

/** ⑤ risk.withdraw.high_commission_rate_bp / high_commission_ratio_bp / min_orders. */
export interface HighCommissionThresholds {
  readonly high_commission_rate_bp: number;
  readonly high_commission_ratio_bp: number;
  readonly min_orders: number;
}

/** ⑥ risk.withdraw.withdraw_received_ratio_bp. */
export interface WithdrawReceivedThresholds {
  readonly withdraw_received_ratio_bp: number;
}

/** The six risk.withdraw.* values. */
export type WithdrawRiskThresholds = InvalidRatioThresholds &
  HighCommissionThresholds &
  WithdrawReceivedThresholds;

/** ④ over the 60-day self-purchase sub-orders: all of them and the invalid ones. */
export interface InvalidRatioCounts {
  readonly orders: number;
  readonly invalid: number;
}

/** ⑤ one sub-order's synced values (联盟预估佣金, 计佣金额); null when the union sent none. */
export interface CommissionFact {
  readonly est_commission_fen: bigint | null;
  readonly commission_base_fen: bigint | null;
}

/**
 * One self-purchase (buy_type=self), attributed sub-order of the member paid in the 60-day window:
 * invalid = rebate_status ∈ {VOID, CLAWED_BACK} or a SUCCEEDED order_rights row.
 */
export interface SelfOrderFact extends CommissionFact {
  readonly invalid: boolean;
}

/** ⑥ 30-day withdrawals (this one included) and the 60-day received rebate shares. */
export interface WithdrawReceivedAmounts {
  readonly withdrawn_fen: bigint;
  readonly received_fen: bigint;
}

const BP = 10000n;

/** A bp (or count) bigint as a JSON-safe integer; beyond 2^53 − 1 it throws rather than round. */
function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('risk flag value exceeds the safe integer range');
  }
  return Number(value);
}

/** numerator × 10000 / denominator floored, and whether it is exactly above `thresholdBp`. */
function ratio(
  numerator: bigint,
  denominator: bigint,
  thresholdBp: number,
): { bp: bigint; above: boolean } {
  // For an integer threshold, numerator × 10000 / denominator > threshold ⇔ its ceiling > threshold.
  return {
    bp: mulDivFloor(numerator, BP, denominator),
    above: mulDivCeil(numerator, BP, denominator) > BigInt(thresholdBp),
  };
}

/** ⑤ the floored rate as bigint; null when it is undefined (missing value, base ≤ 0, est < 0). */
function rateBp(fact: CommissionFact): bigint | null {
  const est = fact.est_commission_fen;
  const base = fact.commission_base_fen;
  if (est === null || base === null || base <= 0n || est < 0n) return null;
  return mulDivFloor(est, BP, base);
}

/** ⑤ a sub-order's commission rate in bp, floored; null when the base is not positive. */
export function commissionRateBp(
  estCommissionFen: bigint,
  commissionBaseFen: bigint,
): number | null {
  const bp = rateBp({
    est_commission_fen: estCommissionFen,
    commission_base_fen: commissionBaseFen,
  });
  return bp === null ? null : safeInteger(bp);
}

/** ④ invalid_ratio_60d, or null when it does not hit. */
export function invalidRatioFlag(
  counts: InvalidRatioCounts,
  thresholds: InvalidRatioThresholds,
): WithdrawRiskFlag | null {
  if (counts.orders <= 0 || counts.invalid < thresholds.invalid_min_count) return null;
  const { bp, above } = ratio(
    BigInt(counts.invalid),
    BigInt(counts.orders),
    thresholds.invalid_ratio_bp,
  );
  if (!above) return null;
  return {
    code: 'invalid_ratio_60d',
    value: safeInteger(bp),
    threshold: thresholds.invalid_ratio_bp,
  };
}

/** ⑤ high_commission_ratio_60d, or null when it does not hit. */
export function highCommissionRatioFlag(
  orders: readonly CommissionFact[],
  thresholds: HighCommissionThresholds,
): WithdrawRiskFlag | null {
  const total = orders.length;
  if (total <= 0 || total < thresholds.min_orders) return null;
  const rate = BigInt(thresholds.high_commission_rate_bp);
  let high = 0n;
  for (const order of orders) {
    const bp = rateBp(order);
    if (bp !== null && bp >= rate) high += 1n;
  }
  const { bp, above } = ratio(high, BigInt(total), thresholds.high_commission_ratio_bp);
  if (!above) return null;
  return {
    code: 'high_commission_ratio_60d',
    value: safeInteger(bp),
    threshold: thresholds.high_commission_ratio_bp,
  };
}

/** ⑥ withdraw_vs_received, or null when it does not hit. A denominator ≤ 0 counts as 0. */
export function withdrawVsReceivedFlag(
  amounts: WithdrawReceivedAmounts,
  thresholds: WithdrawReceivedThresholds,
): WithdrawRiskFlag | null {
  const threshold = thresholds.withdraw_received_ratio_bp;
  if (amounts.received_fen <= 0n) {
    return { code: 'withdraw_vs_received', value: null, threshold };
  }
  const { bp, above } = ratio(amounts.withdrawn_fen, amounts.received_fen, threshold);
  if (!above) return null;
  return { code: 'withdraw_vs_received', value: safeInteger(bp), threshold };
}

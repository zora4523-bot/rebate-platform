// B2-11b: the auto-payout decision of 规划/08 BR-WDR-30 ①–⑬ as a pure function over normalised
// input (money as bigint fen, ratios as integer bp). No clock and no I/O: the caller passes the
// configuration group withdraw.auto_payout.*, created_at, the counts and sums it read under the
// BR-WDR-30 locks, the risk_flags snapshot of W1 and the three ⑧ actual values it computed with
// computeAutoPayoutWarnValues; the engine only compares.
//   every condition is checked (no short-circuit); failed_conditions lists the codes in the order
//   ①–⑬; ① enabled=off → exactly ['disabled'];
//   ② amount_fen ≤ max_amount_fen (equality passes; 0 → never auto);
//   ③ only when window_limit_enabled=on: the +08:00 hh:mm:ss of created_at in the closed interval
//     [window_start, window_end];
//   ⑦ existing count + 1 ≤ max (0 = unlimited);
//   ⑧ strictly '>'; a threshold of 0 disables its item; a null actual value (denominator 0) does
//     not hit high commission / invalid ratio and hits withdraw_received;
//   ⑨ existing platform sum + amount_fen ≤ platform_daily_max_fen (0 → never auto, D10-377);
//   ⑫ risk_flag:<code> for every snapshot code in risk_block_flags plus the real-time
//     blacklist_hit, in the BR-WDR-29 label order whatever the input order.
// computeAutoPayoutWarnValues derives the three ⑧ actual values from the rows the caller read
// for t = created_at (BR-WDR-29 ④⑤⑥ windows and numerators / denominators, BR-WDR-30 ⑧
// differences): a per-order rate counts only when > X; no minimum order or invalid count; a
// denominator of 0 gives null; Y, Z, W do not change the values. A ratio is rounded up to whole
// bp, so that the engine's integer '>' gives the same answer as the exact numerator × 10000 /
// denominator '>' of the rule.
// Not implemented yet (rule-test stage): the bodies only throw.

export type AutoPayoutSwitch = 'off' | 'on';

/** The configuration group withdraw.auto_payout.* (BR-WDR-30 table). */
export interface AutoPayoutConfig {
  enabled: AutoPayoutSwitch;
  max_amount_fen: bigint;
  /** 'HH:00:00', 09–22. */
  window_start: string;
  /** 'HH:59:59', 09–22, later than window_start. */
  window_end: string;
  window_limit_enabled: AutoPayoutSwitch;
  first_withdrawal_limit_enabled: AutoPayoutSwitch;
  frozen_balance_policy: 'no_auto';
  same_day_policy: 'no_auto';
  payee_daily_max_count: number;
  payee_monthly_max_count: number;
  user_daily_max_count: number;
  user_monthly_max_count: number;
  warn: {
    /** X: the per-order commission rate the caller used to compute the high-commission ratio. */
    high_commission_rate_bp: number;
    /** Y. */
    high_commission_order_ratio_bp: number;
    /** Z. */
    invalid_ratio_bp: number;
    /** W. */
    withdraw_received_ratio_bp: number;
  };
  platform_daily_max_fen: bigint;
  /** BR-WDR-29 label codes. */
  risk_block_flags: readonly string[];
}

/** One hit of the withdrawals.risk_flags snapshot (D10-367). */
export interface AutoPayoutRiskFlag {
  readonly code: string;
  readonly value: unknown;
  readonly threshold: unknown;
}

/** The three ⑧ actual values in bp; null when the denominator is 0. */
export interface AutoPayoutWarnValues {
  high_commission_order_ratio_bp: number | null;
  invalid_ratio_bp: number | null;
  withdraw_received_ratio_bp: number | null;
}

/** ⑧ one self-purchase (buy_type=self), attributed sub-order paid in [t − 60×24h, t]. */
export interface AutoPayoutWarnOrder {
  /** BR-WDR-29 ⑤: estimated commission × 10000 / commission base, floored. */
  readonly commission_rate_bp: number;
  /** BR-WDR-29 ④: rebate_status ∈ {VOID, CLAWED_BACK} or a SUCCEEDED order_rights. */
  readonly invalid: boolean;
}

/** ⑧ what the caller read for t = created_at. */
export interface AutoPayoutWarnSource {
  /** Denominator of the high-commission and invalid ratios (BR-WDR-29 ④⑤). */
  readonly orders_60d: readonly AutoPayoutWarnOrder[];
  /**
   * BR-WDR-29 ⑥ numerator: Σ amount_fen of the member's withdrawals created in [t − 30×24h, t],
   * status ∉ {REJECTED, FAILED}, this one included.
   */
  readonly withdrawn_30d_fen: bigint;
  /**
   * BR-WDR-29 ⑥ denominator: the member's rebate shares on sub-orders received in [t − 60×24h, t]
   * (WAITING: current estimate; CREDITED: credited net).
   */
  readonly received_60d_fen: bigint;
}

/** ⑦: auto-paid withdrawals already counted today / this month, this one excluded. */
export interface AutoPayoutCounts {
  payee_daily: number;
  payee_monthly: number;
  user_daily: number;
  user_monthly: number;
}

export interface AutoPayoutInput {
  config: AutoPayoutConfig;
  /** ② amount_fen of the withdrawal (fee and tax included). */
  amount_fen: bigint;
  /** ③ withdrawals.created_at. */
  created_at: Date;
  /** ④ the member has no PAID_API / PAID_MANUAL withdrawal. */
  first_withdrawal: boolean;
  /** ⑤(a) an active withdraw_holds row. */
  active_hold: boolean;
  /** ⑤(a) frozen / appealing count as frozen balance. */
  risk_state: 'normal' | 'frozen' | 'banned' | 'appealing';
  /** ⑤(b) the member's frozen_fen (this withdrawal included). */
  frozen_fen: bigint;
  /** ⑥ credited_today. */
  credited_today: boolean;
  counts: AutoPayoutCounts;
  /** ⑧ actual values. */
  warn_actuals: AutoPayoutWarnValues;
  /** ⑨ Σ amount_fen auto-paid platform-wide today, this withdrawal excluded. */
  platform_daily_auto_fen: bigint;
  /** ⑩ */
  adult: boolean;
  /** ⑪ payout.channel_enabled.<channel of the snapshot payout method>. */
  channel_enabled: boolean;
  /** ⑫ the W1 snapshot. */
  risk_flags: readonly AutoPayoutRiskFlag[];
  /** ⑫ the real-time BR-WDR-29 ⑨ check. */
  blacklist_hit: boolean;
  /** ⑬ BR-WDR-05 / BR-WDR-10 W2 guard. */
  w2_guard_passed: boolean;
}

export type AutoPayoutFailedCondition =
  | 'disabled'
  | 'max_amount'
  | 'outside_window'
  | 'first_withdrawal'
  | 'frozen_balance'
  | 'same_day'
  | 'payee_daily_count'
  | 'payee_monthly_count'
  | 'user_daily_count'
  | 'user_monthly_count'
  | 'warn_high_commission'
  | 'warn_invalid_ratio'
  | 'warn_withdraw_received'
  | 'platform_daily_max'
  | 'minor'
  | 'channel_disabled'
  | `risk_flag:${string}`
  | 'w2_guard';

export interface AutoPayoutDecision {
  result: 'auto' | 'manual';
  failed_conditions: AutoPayoutFailedCondition[];
  warn_values: AutoPayoutWarnValues;
}

export function decideAutoPayout(input: AutoPayoutInput): AutoPayoutDecision {
  void input;
  throw new Error('NotImplemented: decideAutoPayout');
}

export function computeAutoPayoutWarnValues(
  source: AutoPayoutWarnSource,
  warn: AutoPayoutConfig['warn'],
): AutoPayoutWarnValues {
  void source;
  void warn;
  throw new Error('NotImplemented: computeAutoPayoutWarnValues');
}

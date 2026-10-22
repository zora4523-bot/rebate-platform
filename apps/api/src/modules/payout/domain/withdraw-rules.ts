/** B2-05c: normalized input for BR-WDR-03 steps ①–⑬. Money remains bigint fen. */
export interface WithdrawLimits {
  enabled: boolean;
  min_amount_fen: bigint;
  amount_step_fen: bigint;
  max_amount_fen: bigint;
  daily_count_per_user: number;
  monthly_count_per_user: number;
  payee_daily_count: number;
  payee_daily_distinct_users: number;
  method_max_amount_fen: Readonly<Record<'alipay' | 'bank_card' | 'wechat', bigint>>;
  minor_monthly_cap_fen: bigint;
  self_purchase_enabled: boolean;
  self_purchase_min_fen: bigint;
  allowed_member_levels: readonly string[];
}

export interface WithdrawUsage {
  daily_count: number;
  monthly_count: number;
  payee_daily_count: number;
  /** Distinct OTHER members using the snapshot payee HMAC today. */
  payee_daily_other_users: number;
  monthly_amount_fen: bigint;
}

export interface WithdrawBlock {
  code: number;
  data: Readonly<Record<string, string | bigint>>;
}

export interface WithdrawRuleInput {
  limits: WithdrawLimits;
  step_up_valid: boolean;
  risk_state: 'normal' | 'frozen' | 'banned' | 'appealing';
  prev_risk_state: 'frozen' | 'banned' | null;
  blocklist_risk_msg_code: string | null;
  reverify: { code: number; data: { method: string } } | null;
  realname_verified: boolean;
  payout_method: 'alipay' | 'bank_card' | 'wechat' | null;
  names_match: boolean;
  labor_agreement_signed: boolean;
  active_hold: boolean;
  available_fen: bigint;
  usage: WithdrawUsage;
  minor: boolean;
  self_purchase_count: number;
  self_purchase_fen: bigint;
}

export interface WithdrawRuleSummary {
  can_withdraw: boolean;
  block_code: number | null;
  block_reason: string | null;
  max_withdrawable_fen: bigint;
  withdrawable_fen: bigint;
  daily_remaining: number;
  monthly_remaining: number;
}

/** No auth/idempotency/version work here. netFen comes from FeeTaxCalculator. */
export function validateWithdrawal(
  input: WithdrawRuleInput,
  amountFen: bigint,
  netFen: bigint,
): WithdrawBlock | null {
  void input;
  void amountFen;
  void netFen;
  throw new Error('NotImplemented: validateWithdrawal');
}

/** Read-only projection skips step-up and comparisons against the requested amount. */
export function withdrawalRules(input: WithdrawRuleInput): WithdrawRuleSummary {
  void input;
  throw new Error('NotImplemented: withdrawalRules');
}

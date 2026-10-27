// B2-11b fixtures for decideAutoPayout (规划/08 BR-WDR-30 ①–⑬). Every value is a literal written
// from the rule text, never read from the implementation:
//   defaults()  the BR-WDR-30 table defaults (enabled off, ¥300, 09:00:00–22:59:59, limits off,
//               no_auto ×2, counts 1 / 2 / 1 / 1, warn 10000 / 10000 / 10000 / 0, ¥2,000, the five
//               block flags);
//   passing()   the defaults with enabled=on and an input meeting ①–⑬ (the 细则 example: 10:30,
//               ¥280, no auto-paid withdrawal this month, no block flag);
//   failing()   passing() with exactly the given conditions failing, each by the smallest step past
//               its edge; ORDER is the ①–⑬ order of failed_conditions.
import type {
  AutoPayoutConfig,
  AutoPayoutFailedCondition,
  AutoPayoutInput,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';

/** BR-WDR-30 ⑫ default risk_block_flags. */
export const DEFAULT_BLOCK_FLAGS = [
  'same_device_multi_account',
  'had_negative',
  'recon_diff',
  'payee_prev_other_user',
  'risk_calc_failed',
] as const;

/** The BR-WDR-29 labels in their numbering ①–⑩, then risk_calc_failed: the order inside ⑫. */
export const LABEL_ORDER = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'blacklist_hit',
  'payee_prev_other_user',
  'risk_calc_failed',
] as const;

/** Labels the W1 snapshot can carry (blacklist_hit is only checked in real time). */
export const SNAPSHOT_LABELS = LABEL_ORDER.filter((code) => code !== 'blacklist_hit');

export type Failable =
  Exclude<AutoPayoutFailedCondition, 'disabled' | `risk_flag:${string}`> | 'risk_flag:had_negative';

/** failed_conditions order ②–⑬ (① off records only disabled). */
export const ORDER: readonly Failable[] = [
  'max_amount',
  'outside_window',
  'first_withdrawal',
  'frozen_balance',
  'same_day',
  'payee_daily_count',
  'payee_monthly_count',
  'user_daily_count',
  'user_monthly_count',
  'warn_high_commission',
  'warn_invalid_ratio',
  'warn_withdraw_received',
  'platform_daily_max',
  'minor',
  'channel_disabled',
  'risk_flag:had_negative',
  'w2_guard',
];

/** A +08:00 wall-clock instant ('HH:MM:SS' or 'HH:MM:SS.mmm'). */
export function at(time: string, day = '2026-10-12'): Date {
  return new Date(`${day}T${time}+08:00`);
}

export function defaults(): AutoPayoutConfig {
  return {
    enabled: 'off',
    max_amount_fen: 30000n,
    window_start: '09:00:00',
    window_end: '22:59:59',
    window_limit_enabled: 'off',
    first_withdrawal_limit_enabled: 'off',
    frozen_balance_policy: 'no_auto',
    same_day_policy: 'no_auto',
    payee_daily_max_count: 1,
    payee_monthly_max_count: 2,
    user_daily_max_count: 1,
    user_monthly_max_count: 1,
    warn: {
      high_commission_rate_bp: 10000,
      high_commission_order_ratio_bp: 10000,
      invalid_ratio_bp: 10000,
      withdraw_received_ratio_bp: 0,
    },
    platform_daily_max_fen: 200000n,
    risk_block_flags: [...DEFAULT_BLOCK_FLAGS],
  };
}

export function passing(): AutoPayoutInput {
  return {
    config: { ...defaults(), enabled: 'on' },
    amount_fen: 28000n,
    created_at: at('10:30:00'),
    first_withdrawal: false,
    active_hold: false,
    risk_state: 'normal',
    frozen_fen: 28000n,
    credited_today: false,
    counts: { payee_daily: 0, payee_monthly: 0, user_daily: 0, user_monthly: 0 },
    warn_actuals: {
      high_commission_order_ratio_bp: 2000,
      invalid_ratio_bp: 1000,
      withdraw_received_ratio_bp: 5000,
    },
    platform_daily_auto_fen: 0n,
    adult: true,
    channel_enabled: true,
    risk_flags: [],
    blacklist_hit: false,
    w2_guard_passed: true,
  };
}

/**
 * passing() for `amount` with exactly `codes` failing. ② and ⑨ sit on their edge: max_amount_fen
 * = amount passes (amount − 1 fails; 0 when amount is 0, which never auto-pays); the platform sum
 * 100 + amount = platform_daily_max_fen passes, 101 + amount fails.
 */
export function failing(codes: ReadonlySet<Failable>, amount = 28000n): AutoPayoutInput {
  const value = passing();
  const has = (code: Failable) => codes.has(code);
  value.amount_fen = amount;
  value.frozen_fen = amount;
  if (has('max_amount')) value.config.max_amount_fen = amount > 0n ? amount - 1n : 0n;
  else value.config.max_amount_fen = amount > 0n ? amount : 1n;
  value.config.platform_daily_max_fen = 100n + amount;
  value.platform_daily_auto_fen = has('platform_daily_max') ? 101n : 100n;
  if (has('outside_window')) {
    value.config.window_limit_enabled = 'on';
    value.created_at = at('23:00:00');
  }
  if (has('first_withdrawal')) {
    value.config.first_withdrawal_limit_enabled = 'on';
    value.first_withdrawal = true;
  }
  if (has('frozen_balance')) value.active_hold = true;
  if (has('same_day')) value.credited_today = true;
  if (has('payee_daily_count')) value.counts.payee_daily = 1;
  if (has('payee_monthly_count')) value.counts.payee_monthly = 2;
  if (has('user_daily_count')) value.counts.user_daily = 1;
  if (has('user_monthly_count')) value.counts.user_monthly = 1;
  if (has('warn_high_commission')) {
    value.config.warn.high_commission_order_ratio_bp = 5000;
    value.warn_actuals.high_commission_order_ratio_bp = 5001;
  }
  if (has('warn_invalid_ratio')) {
    value.config.warn.invalid_ratio_bp = 3000;
    value.warn_actuals.invalid_ratio_bp = 3001;
  }
  if (has('warn_withdraw_received')) {
    value.config.warn.withdraw_received_ratio_bp = 10000;
    value.warn_actuals.withdraw_received_ratio_bp = 10001;
  }
  if (has('minor')) value.adult = false;
  if (has('channel_disabled')) value.channel_enabled = false;
  if (has('risk_flag:had_negative')) {
    value.risk_flags = [{ code: 'had_negative', value: true, threshold: null }];
  }
  if (has('w2_guard')) value.w2_guard_passed = false;
  return value;
}

/** The expected failed_conditions of failing(codes): the codes in the order ②–⑬. */
export function ordered(codes: ReadonlySet<Failable>): Failable[] {
  return ORDER.filter((code) => codes.has(code));
}

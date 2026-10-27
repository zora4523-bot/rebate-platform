// B2-11d fixtures for the BR-WDR-30 save check and enable precheck (规划/08 07_WDR at SPEC_REF
// 736d24c). Every value is a literal written from the rule text, never read from the
// implementation:
//   the save check's keys and 08 defaults (② ¥300 ≤ withdraw.max_amount_fen ¥5,000 (BR-WDR-04);
//   ③ 09:00:00 / 22:59:59; ⑨ ¥2,000 ≤ payout.daily_cap_fen ¥50,000 (BR-WDR-22); ⑫ the five
//   default block flags), the BR-WDR-29 label codes ①–⑩ plus risk_calc_failed;
//   the precheck keys payout.auto_enable_check.* (B2-11d: 08 names no key; the owner registers
//   BR-WDR-22 ② ⑤ ⑧ as JSON true and the reconciliation days as integers when enabling).

export const MAX = 'withdraw.auto_payout.max_amount_fen';
export const WITHDRAW_MAX = 'withdraw.max_amount_fen';
export const WINDOW_START = 'withdraw.auto_payout.window_start';
export const WINDOW_END = 'withdraw.auto_payout.window_end';
export const PLATFORM_MAX = 'withdraw.auto_payout.platform_daily_max_fen';
export const DAILY_CAP = 'payout.daily_cap_fen';
export const BLOCK_FLAGS = 'withdraw.auto_payout.risk_block_flags';

/** BR-WDR-30 ⑫ default risk_block_flags. */
export const DEFAULT_BLOCK_FLAGS = [
  'same_device_multi_account',
  'had_negative',
  'recon_diff',
  'payee_prev_other_user',
  'risk_calc_failed',
] as const;

/** BR-WDR-29 label codes ①–⑩, then risk_calc_failed. */
export const LABEL_CODES = [
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

/** The 08 defaults of every key the save check reads, written out. */
export function savedDefaults(): Map<string, unknown> {
  return new Map<string, unknown>([
    [MAX, 30000],
    [WITHDRAW_MAX, 500000],
    [WINDOW_START, '09:00:00'],
    [WINDOW_END, '22:59:59'],
    [PLATFORM_MAX, 200000],
    [DAILY_CAP, 5000000],
    [BLOCK_FLAGS, [...DEFAULT_BLOCK_FLAGS]],
  ]);
}

/** BR-WDR-30 ③ options: 'HH' + suffix for HH 09–22. */
export function windowHours(suffix: ':00:00' | ':59:59'): string[] {
  return Array.from({ length: 14 }, (_, i) => `${String(9 + i).padStart(2, '0')}${suffix}`);
}

export const LIMITS_SUPPORTED = 'payout.auto_enable_check.limits_supported';
export const STATUS_CODES_SUPPORTED = 'payout.auto_enable_check.status_codes_supported';
export const BILL_SUPPORTED = 'payout.auto_enable_check.bill_out_biz_no_supported';
export const RECON_REQUIRED_DAYS = 'payout.auto_enable_check.recon_required_days';
export const RECON_PASSED_DAYS = 'payout.auto_enable_check.recon_passed_days';

export const ENABLE_KEYS = [
  LIMITS_SUPPORTED,
  STATUS_CODES_SUPPORTED,
  BILL_SUPPORTED,
  RECON_REQUIRED_DAYS,
  RECON_PASSED_DAYS,
] as const;

/** Item codes in listing order: BR-WDR-22 ② ⑤ ⑧, then the BR-WDR-23 days. */
export const ITEM_CODES = [
  'limits_supported',
  'status_codes_supported',
  'bill_out_biz_no_supported',
  'recon_days',
] as const;

export type ItemCode = (typeof ITEM_CODES)[number];

/** Everything registered: ② ⑤ ⑧ supported, reconciliation run through 7 of 7 days. */
export function enablePassing(): Map<string, unknown> {
  return new Map<string, unknown>([
    [LIMITS_SUPPORTED, true],
    [STATUS_CODES_SUPPORTED, true],
    [BILL_SUPPORTED, true],
    [RECON_REQUIRED_DAYS, 7],
    [RECON_PASSED_DAYS, 7],
  ]);
}

/** The expected check when exactly `failing` items do not pass. */
export function expectedCheck(failing: readonly ItemCode[]) {
  return {
    passed: failing.length === 0,
    items: ITEM_CODES.map((code) => ({ code, passed: !failing.includes(code) })),
  };
}

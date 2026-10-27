// B2-11a oracle (规划/08 BR-WDR-29; task 9.3 取值): the six risk.withdraw.* keys and defaults, the
// label order and synthetic facts with their expected labels, all written out by hand and never
// computed by the code under test. Type-only imports, so the unit tests load nothing else.
import type {
  SelfOrderFact,
  WithdrawRiskFlag,
  WithdrawRiskFlagCode,
  WithdrawRiskThresholds,
} from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';

export type ThresholdName = keyof WithdrawRiskThresholds;

/** 9.3 #6: the configuration keys. */
export const KEYS: Readonly<Record<ThresholdName, string>> = {
  invalid_ratio_bp: 'risk.withdraw.invalid_ratio_bp',
  invalid_min_count: 'risk.withdraw.invalid_min_count',
  high_commission_rate_bp: 'risk.withdraw.high_commission_rate_bp',
  high_commission_ratio_bp: 'risk.withdraw.high_commission_ratio_bp',
  min_orders: 'risk.withdraw.min_orders',
  withdraw_received_ratio_bp: 'risk.withdraw.withdraw_received_ratio_bp',
};

/** 9.3 #6 / BR-WDR-29 默认值. */
export const DEFAULTS: WithdrawRiskThresholds = {
  invalid_ratio_bp: 3000,
  invalid_min_count: 3,
  high_commission_rate_bp: 5000,
  high_commission_ratio_bp: 5000,
  min_orders: 5,
  withdraw_received_ratio_bp: 10000,
};

/** BR order ①②③④⑤⑥⑦⑧⑩; risk_calc_failed, when present, comes last. */
export const CODES: readonly WithdrawRiskFlagCode[] = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'payee_prev_other_user',
];

export function flag(
  code: WithdrawRiskFlag['code'],
  value: WithdrawRiskFlag['value'] = true,
  threshold: number | null = null,
): WithdrawRiskFlag {
  return { code, value, threshold };
}

export function failed(...codes: WithdrawRiskFlagCode[]): WithdrawRiskFlag {
  return { code: 'risk_calc_failed', value: codes, threshold: null };
}

const HIGH = { est_commission_fen: 60n, commission_base_fen: 100n } as const; // 6000 bp
const LOW = { est_commission_fen: 10n, commission_base_fen: 100n } as const; // 1000 bp

/** Ten self-purchase sub-orders: 4 invalid (④ 4000 bp), 6 at 6000 bp (⑤ 6000 bp). */
export const LOUD_ORDERS: readonly SelfOrderFact[] = [
  { invalid: true, ...HIGH },
  { invalid: true, ...HIGH },
  { invalid: true, ...HIGH },
  { invalid: true, ...HIGH },
  { invalid: false, ...HIGH },
  { invalid: false, ...HIGH },
  { invalid: false, ...LOW },
  { invalid: false, ...LOW },
  { invalid: false, ...LOW },
  { invalid: false, ...LOW },
];

/** What a stub facts reader answers. */
export interface FactValues {
  readonly paid: boolean;
  readonly credited: boolean;
  readonly orders: readonly SelfOrderFact[];
  readonly withdrawn: bigint;
  readonly received: bigint;
  readonly negative: boolean;
  readonly recon: boolean;
  readonly payeePrev: boolean;
}

/** Every fact on the hit side; with ③ marked and amount 1000 fen: LOUD_FLAGS. */
export const LOUD: FactValues = {
  paid: false,
  credited: true,
  orders: LOUD_ORDERS,
  // ⑥: 49000 + this application's 1000 = 50000 over 32000 → 15625 bp (BR-WDR-29 例 ¥500 / ¥320).
  withdrawn: 49000n,
  received: 32000n,
  negative: true,
  recon: true,
  payeePrev: true,
};

/** Every fact on the quiet side; with ③ unmarked and amount 1000 fen: no label at all. */
export const QUIET: FactValues = {
  paid: true,
  credited: false,
  orders: [],
  withdrawn: 0n,
  received: 1000000n,
  negative: false,
  recon: false,
  payeePrev: false,
};

/** LOUD with ③ marked, default thresholds, amount 1000 fen. */
export const LOUD_FLAGS: readonly WithdrawRiskFlag[] = [
  flag('first_withdrawal'),
  flag('credited_today'),
  flag('same_device_multi_account'),
  flag('invalid_ratio_60d', 4000, 3000),
  flag('high_commission_ratio_60d', 6000, 5000),
  flag('withdraw_vs_received', 15625, 10000),
  flag('had_negative'),
  flag('recon_diff'),
  flag('payee_prev_other_user'),
];

/** LOUD_FLAGS without `codes`, followed by risk_calc_failed listing them. */
export function loudFailing(...codes: WithdrawRiskFlagCode[]): WithdrawRiskFlag[] {
  return [
    ...LOUD_FLAGS.filter((entry) => !codes.some((code) => code === entry.code)),
    failed(...codes),
  ];
}

// F1-02zx §9.2–9.3; BR-INV-24 细则 l.560/l.571 at SPEC_REF ac4d993.
// Independent expectations: never derive these from the registry under test.
export const KEY = 'growth.invite_reward.eligibility_days';
export const ENABLED = 'growth.invite_reward.enabled';
export const AMOUNT = 'growth.invite_reward.amount_fen';
export const DAILY = 'growth.invite_reward.daily_budget_fen';
export const TOTAL = 'growth.invite_reward.total_budget_fen';
export const WINDOW = 'growth.invite_reward.ip_window_hours';
export const DEFAULTS = [
  { key: AMOUNT, value: 1000 },
  { key: DAILY, value: 0 },
  { key: TOTAL, value: 0 },
  { key: 'growth.invite_reward.min_paid_fen', value: 0 },
  { key: WINDOW, value: 24 },
  { key: KEY, value: 30 },
] as const;
export const SPEC = {
  key: KEY,
  valueType: 'number',
  options: null,
  permission: 'config.business',
  adminEditable: true,
  range: { integer: true, min: 1, max: 3650 },
} as const;

// F1-02zn §9.2 + §9.8 D10-94；独立预期，不从被测注册表生成。
export const PREFIX = 'growth.invite_reward.';
export const AMOUNT = `${PREFIX}amount_fen`;
export const DAILY = `${PREFIX}daily_budget_fen`;
export const TOTAL = `${PREFIX}total_budget_fen`;
export const MIN_PAID = `${PREFIX}min_paid_fen`;
export const WINDOW = `${PREFIX}ip_window_hours`;
export const ENABLED = `${PREFIX}enabled`;
export const PAUSED = `${PREFIX}payout_paused`;
export const POSITIVE_WHEN_ENABLED = [AMOUNT, DAILY, TOTAL] as const;
export const CONFIGS = [
  { key: AMOUNT, permission: 'config.business', min: 0, seed: 1000 },
  { key: DAILY, permission: 'config.business', min: 0, seed: 0 },
  { key: TOTAL, permission: 'config.business', min: 0, seed: 0 },
  { key: MIN_PAID, permission: 'config.business', min: 0, seed: 0 },
  { key: WINDOW, permission: 'config.risk', min: 1, seed: 24 },
] as const;

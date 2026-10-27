// B2-11b decideAutoPayout as a whole (规划/08 BR-WDR-30 表格行与细则「判定顺序与记录」及各例):
// ①–⑬ are all checked, never stopping at the first failure; failed_conditions lists every failed
// code in the order ①–⑬; ① enabled=off records only disabled; auto exactly when nothing failed;
// warn_values records the three ⑧ actual values.
import { expect, it } from 'vitest';
import { decideAutoPayout } from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { ORDER, at, defaults, failing, ordered, passing, type Failable } from './kit.ts';

it('[AC-B2-11b#1] ①–⑬ 全部满足 → auto，failed_conditions 为空，warn_values 记 ⑧ 三项实际值', () => {
  expect(decideAutoPayout(passing())).toEqual({
    result: 'auto',
    failed_conditions: [],
    warn_values: {
      high_commission_order_ratio_bp: 2000,
      invalid_ratio_bp: 1000,
      withdraw_received_ratio_bp: 5000,
    },
  });
});

it('[AC-B2-11b#2] ① 默认 enabled=off → manual，failed_conditions 恰为 [disabled]', () => {
  const value = passing();
  value.config = defaults();
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['disabled'],
  });
});

it('[AC-B2-11b#3] ① off 时其余条件全不满足也只记 disabled', () => {
  const value = failing(new Set(ORDER));
  value.config.enabled = 'off';
  value.blacklist_hit = true;
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['disabled'],
  });
});

it('[AC-B2-11b#4] 全部检查不短路：②–⑬ 同时不满足时按 ①–⑬ 顺序全列', () => {
  expect(decideAutoPayout(failing(new Set(ORDER)))).toMatchObject({
    result: 'manual',
    failed_conditions: [...ORDER],
  });
});

it.each(ORDER.map((code) => ({ code })))(
  '[AC-B2-11b#5] 只有 $code 不满足 → manual，failed_conditions 恰为该一项',
  ({ code }) => {
    expect(decideAutoPayout(failing(new Set([code])))).toMatchObject({
      result: 'manual',
      failed_conditions: [code],
    });
  },
);

it.each([
  { label: '首尾', codes: ['w2_guard', 'max_amount'] },
  { label: '⑩ 与 ⑥', codes: ['minor', 'same_day'] },
  {
    label: '⑦ 四项',
    codes: ['user_monthly_count', 'payee_daily_count', 'user_daily_count', 'payee_monthly_count'],
  },
  {
    label: '⑧ 三项与 ⑨',
    codes: [
      'platform_daily_max',
      'warn_withdraw_received',
      'warn_high_commission',
      'warn_invalid_ratio',
    ],
  },
  {
    label: '⑪ ⑫ ⑬ 与 ③',
    codes: ['risk_flag:had_negative', 'w2_guard', 'channel_disabled', 'outside_window'],
  },
] satisfies { label: string; codes: Failable[] }[])(
  '[AC-B2-11b#6] 多条不满足（$label）全列且按 ①–⑬ 排序，与条件写入顺序无关',
  ({ codes }) => {
    const set = new Set(codes);
    expect(decideAutoPayout(failing(set)).failed_conditions).toEqual(ordered(set));
  },
);

it('[AC-B2-11b#7] 细则例：已有已到账提现、本月无自动到账、无阻断标签，10:30 申请 ¥280 → auto', () => {
  const value = passing();
  value.amount_fen = 28000n;
  value.frozen_fen = 28000n;
  value.created_at = at('10:30:00');
  value.first_withdrawal = false;
  expect(decideAutoPayout(value)).toMatchObject({ result: 'auto', failed_conditions: [] });
});

it('[AC-B2-11b#8] 细则例：申请 ¥350 → [max_amount]', () => {
  const value = passing();
  value.amount_fen = 35000n;
  value.frozen_fen = 35000n;
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['max_amount'],
  });
});

it('[AC-B2-11b#9] 细则例：首次提现 ¥50，首提限制 off → auto；改为 on → [first_withdrawal]', () => {
  const value = passing();
  value.amount_fen = 5000n;
  value.frozen_fen = 5000n;
  value.first_withdrawal = true;
  expect(decideAutoPayout(value)).toMatchObject({ result: 'auto', failed_conditions: [] });
  value.config.first_withdrawal_limit_enabled = 'on';
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['first_withdrawal'],
  });
});

it('[AC-B2-11b#10] 细则例：本月已有 1 笔自动到账，再申请 ¥100 → [user_monthly_count]', () => {
  const value = passing();
  value.amount_fen = 10000n;
  value.frozen_fen = 10000n;
  value.created_at = at('10:00:00', '2026-10-20');
  value.counts = { payee_daily: 0, payee_monthly: 1, user_daily: 0, user_monthly: 1 };
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['user_monthly_count'],
  });
});

it('[AC-B2-11b#11] 细则例：月结入账当天 15:00 申请 → [same_day]', () => {
  const value = passing();
  value.created_at = at('15:00:00', '2026-10-24');
  value.credited_today = true;
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['same_day'],
  });
});

it('[AC-B2-11b#12] 细则例：23:30 申请，时段限制 off → auto；改为 on → [outside_window]', () => {
  const value = passing();
  value.created_at = at('23:30:00');
  expect(decideAutoPayout(value)).toMatchObject({ result: 'auto', failed_conditions: [] });
  value.config.window_limit_enabled = 'on';
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['outside_window'],
  });
});

it('[AC-B2-11b#13] 细则例：银行卡收款、银行卡通道 off → [channel_disabled]', () => {
  const value = passing();
  value.channel_enabled = false;
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['channel_disabled'],
  });
});

it('[AC-B2-11b#14] 细则例：risk_flags 含 had_negative → [risk_flag:had_negative]', () => {
  const value = passing();
  value.risk_flags = [{ code: 'had_negative', value: true, threshold: null }];
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['risk_flag:had_negative'],
  });
});

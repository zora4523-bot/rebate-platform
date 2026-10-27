// B2-11b the edges of each condition of decideAutoPayout (规划/08 BR-WDR-30 细则 ②–⑪ ⑬), each with
// a passing and a failing side:
//   ② amount_fen ≤ max_amount_fen, equality passes; max 0 → never auto;
//   ③ only with window_limit_enabled=on: the +08:00 hh:mm:ss of created_at in the closed
//     [window_start, window_end] (milliseconds do not count);
//   ④ only with first_withdrawal_limit_enabled=on;
//   ⑤ (a) active withdraw_holds or risk_state ∈ {frozen, appealing}; (b) frozen_fen > amount_fen;
//   ⑥ credited_today;
//   ⑦ existing + 1 ≤ max, 0 = unlimited;
//   ⑧ strictly '>'; a threshold of 0 disables the item; denominator 0 (null) does not hit
//     high commission / invalid ratio and hits withdraw_received;
//   ⑨ existing platform sum + amount_fen ≤ platform_daily_max_fen;
//   ⑩ minor, ⑪ channel off, ⑬ W2 guard.
import { expect, it } from 'vitest';
import {
  decideAutoPayout,
  type AutoPayoutCounts,
  type AutoPayoutInput,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { at, passing } from './kit.ts';

function failed(value: AutoPayoutInput) {
  return decideAutoPayout(value).failed_conditions;
}

function withAmount(amount: bigint): AutoPayoutInput {
  const value = passing();
  value.amount_fen = amount;
  value.frozen_fen = amount;
  value.config.platform_daily_max_fen = 100_000_000n;
  return value;
}

it('[AC-B2-11b#15] ② 金额上限含等号：¥300.00 自动，¥300.01 转人工', () => {
  expect(decideAutoPayout(withAmount(30000n))).toMatchObject({
    result: 'auto',
    failed_conditions: [],
  });
  expect(decideAutoPayout(withAmount(30001n))).toMatchObject({
    result: 'manual',
    failed_conditions: ['max_amount'],
  });
  expect(failed(withAmount(29999n))).toEqual([]);
});

it('[AC-B2-11b#16] ② 非默认上限同样含等号（1000000 分）', () => {
  const equal = withAmount(1_000_000n);
  equal.config.max_amount_fen = 1_000_000n;
  expect(failed(equal)).toEqual([]);
  const over = withAmount(1_000_001n);
  over.config.max_amount_fen = 1_000_000n;
  expect(failed(over)).toEqual(['max_amount']);
});

it('[AC-B2-11b#17] ② max_amount_fen=0 表示任何金额都不自动到账', () => {
  for (const amount of [100n, 1n, 30000n]) {
    const value = withAmount(amount);
    value.config.max_amount_fen = 0n;
    expect(failed(value)).toEqual(['max_amount']);
  }
});

it('[AC-B2-11b#18] ③ window_limit_enabled=off 时不限时段：全天含夜间与时段外都不记 outside_window', () => {
  for (const time of ['00:00:00', '08:59:59', '23:00:00', '23:30:00', '23:59:59']) {
    const value = passing();
    value.created_at = at(time);
    expect(failed(value)).toEqual([]);
  }
});

it.each([
  { time: '09:00:00', inside: true },
  { time: '09:00:00.001', inside: true },
  { time: '15:30:00', inside: true },
  { time: '22:59:59', inside: true },
  { time: '22:59:59.999', inside: true },
  { time: '08:59:59', inside: false },
  { time: '08:59:59.999', inside: false },
  { time: '23:00:00', inside: false },
  { time: '00:00:00', inside: false },
  { time: '23:59:59.999', inside: false },
])(
  '[AC-B2-11b#19] ③ 时段限制 on、默认 [09:00:00, 22:59:59] 闭区间按时分秒：$time 时段内 = $inside',
  ({ time, inside }) => {
    const value = passing();
    value.config.window_limit_enabled = 'on';
    value.created_at = at(time);
    expect(failed(value)).toEqual(inside ? [] : ['outside_window']);
  },
);

it('[AC-B2-11b#20] ③ 非默认时段 [10:00:00, 10:59:59] 两端含、端外一秒不含', () => {
  const cases = [
    { time: '10:00:00', inside: true },
    { time: '10:59:59', inside: true },
    { time: '09:59:59', inside: false },
    { time: '11:00:00', inside: false },
  ];
  for (const { time, inside } of cases) {
    const value = passing();
    value.config.window_limit_enabled = 'on';
    value.config.window_start = '10:00:00';
    value.config.window_end = '10:59:59';
    value.created_at = at(time);
    expect(failed(value)).toEqual(inside ? [] : ['outside_window']);
  }
});

it('[AC-B2-11b#21] ③ 时分秒取 +08:00 而不是 UTC', () => {
  const value = passing();
  value.config.window_limit_enabled = 'on';
  value.config.window_start = '10:00:00';
  value.config.window_end = '10:59:59';
  // 10:30 UTC = 18:30 +08:00 → outside; 02:30 UTC = 10:30 +08:00 → inside.
  value.created_at = new Date('2026-10-12T10:30:00.000Z');
  expect(failed(value)).toEqual(['outside_window']);
  value.created_at = new Date('2026-10-12T02:30:00.000Z');
  expect(failed(value)).toEqual([]);
  // Default window: 14:59:59 UTC = 22:59:59 +08:00 inside; 15:30 UTC = 23:30 +08:00 outside;
  // 16:30 UTC = 00:30 +08:00 of the next day outside (UTC 16:30 would be inside by UTC).
  value.config.window_start = '09:00:00';
  value.config.window_end = '22:59:59';
  value.created_at = new Date('2026-10-12T14:59:59.000Z');
  expect(failed(value)).toEqual([]);
  value.created_at = new Date('2026-10-12T15:30:00.000Z');
  expect(failed(value)).toEqual(['outside_window']);
  value.created_at = new Date('2026-10-12T16:30:00.000Z');
  expect(failed(value)).toEqual(['outside_window']);
  // 01:00 UTC = 09:00 +08:00 inside, although 01:00 is outside by UTC.
  value.created_at = new Date('2026-10-12T01:00:00.000Z');
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#22] ④ 首提限制：off 时首提不记；on 时首提记 first_withdrawal，非首提不记', () => {
  const value = passing();
  value.first_withdrawal = true;
  expect(failed(value)).toEqual([]);
  value.config.first_withdrawal_limit_enabled = 'on';
  expect(failed(value)).toEqual(['first_withdrawal']);
  value.first_withdrawal = false;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#23] ⑤(a) 生效的 withdraw_holds，或 risk_state ∈ {frozen, appealing} → frozen_balance', () => {
  const hold = passing();
  hold.active_hold = true;
  expect(failed(hold)).toEqual(['frozen_balance']);
  for (const state of ['frozen', 'appealing'] as const) {
    const value = passing();
    value.risk_state = state;
    expect(failed(value)).toEqual(['frozen_balance']);
  }
  const normal = passing();
  normal.risk_state = 'normal';
  expect(failed(normal)).toEqual([]);
});

it('[AC-B2-11b#24] ⑤(a) 只看 frozen / appealing：banned 不记 frozen_balance（提现阻断由 ⑬ 判）', () => {
  const value = passing();
  value.risk_state = 'banned';
  value.w2_guard_passed = false;
  expect(failed(value)).toEqual(['w2_guard']);
});

it('[AC-B2-11b#25] ⑤(b) frozen_fen > 本单 amount_fen 才记 frozen_balance（等于本单不记）', () => {
  const value = passing();
  value.frozen_fen = value.amount_fen;
  expect(failed(value)).toEqual([]);
  value.frozen_fen = value.amount_fen + 1n;
  expect(failed(value)).toEqual(['frozen_balance']);
  value.frozen_fen = 0n;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#26] ⑥ 当日有收益入账 → same_day；没有不记', () => {
  const value = passing();
  value.credited_today = true;
  expect(failed(value)).toEqual(['same_day']);
  value.credited_today = false;
  expect(failed(value)).toEqual([]);
});

const COUNTERS = [
  { counter: 'payee_daily', key: 'payee_daily_max_count', code: 'payee_daily_count' },
  { counter: 'payee_monthly', key: 'payee_monthly_max_count', code: 'payee_monthly_count' },
  { counter: 'user_daily', key: 'user_daily_max_count', code: 'user_daily_count' },
  { counter: 'user_monthly', key: 'user_monthly_max_count', code: 'user_monthly_count' },
] as const satisfies readonly {
  counter: keyof AutoPayoutCounts;
  key: string;
  code: string;
}[];

it.each(COUNTERS)(
  '[AC-B2-11b#27] ⑦ $code：已有数 + 1 ≤ 上限（含本单），等于上限的已有数即转人工',
  ({ counter, key, code }) => {
    for (const max of [1, 2, 5]) {
      const value = passing();
      value.config[key] = max;
      value.counts[counter] = max - 1;
      expect(failed(value)).toEqual([]);
      value.counts[counter] = max;
      expect(failed(value)).toEqual([code]);
    }
  },
);

it.each(COUNTERS)('[AC-B2-11b#28] ⑦ $key=0 表示不限', ({ counter, key }) => {
  for (const existing of [0, 1, 999]) {
    const value = passing();
    value.config[key] = 0;
    value.counts[counter] = existing;
    expect(failed(value)).toEqual([]);
  }
});

it('[AC-B2-11b#29] ⑦ 默认 1 / 2 / 1 / 1：收款账号当月已有 1 笔仍可自动，已有 2 笔转人工', () => {
  const value = passing();
  value.counts.payee_monthly = 1;
  expect(failed(value)).toEqual([]);
  value.counts.payee_monthly = 2;
  expect(failed(value)).toEqual(['payee_monthly_count']);
});

it('[AC-B2-11b#30] ⑧ 高佣占比一律「>」：等于 Y 不记，多 1bp 记 warn_high_commission', () => {
  const value = passing();
  value.config.warn.high_commission_order_ratio_bp = 5000;
  value.warn_actuals.high_commission_order_ratio_bp = 5000;
  expect(failed(value)).toEqual([]);
  value.warn_actuals.high_commission_order_ratio_bp = 5001;
  expect(failed(value)).toEqual(['warn_high_commission']);
});

it('[AC-B2-11b#31] ⑧ 失效占比一律「>」：等于 Z 不记，多 1bp 记 warn_invalid_ratio', () => {
  const value = passing();
  value.config.warn.invalid_ratio_bp = 3000;
  value.warn_actuals.invalid_ratio_bp = 3000;
  expect(failed(value)).toEqual([]);
  value.warn_actuals.invalid_ratio_bp = 3001;
  expect(failed(value)).toEqual(['warn_invalid_ratio']);
});

it('[AC-B2-11b#32] ⑧ 提现额 / 确认收货佣金一律「>」：等于 W 不记，多 1bp 记 warn_withdraw_received', () => {
  const value = passing();
  value.config.warn.withdraw_received_ratio_bp = 10000;
  value.warn_actuals.withdraw_received_ratio_bp = 10000;
  expect(failed(value)).toEqual([]);
  value.warn_actuals.withdraw_received_ratio_bp = 10001;
  expect(failed(value)).toEqual(['warn_withdraw_received']);
});

it('[AC-B2-11b#33] ⑧ 分母为 0：高佣占比与失效占比不命中，提现额 / 确认收货佣金命中', () => {
  const value = passing();
  value.config.warn.high_commission_order_ratio_bp = 1;
  value.config.warn.invalid_ratio_bp = 1;
  value.config.warn.withdraw_received_ratio_bp = 10000;
  value.warn_actuals = {
    high_commission_order_ratio_bp: null,
    invalid_ratio_bp: null,
    withdraw_received_ratio_bp: null,
  };
  expect(decideAutoPayout(value)).toEqual({
    result: 'manual',
    failed_conditions: ['warn_withdraw_received'],
    warn_values: {
      high_commission_order_ratio_bp: null,
      invalid_ratio_bp: null,
      withdraw_received_ratio_bp: null,
    },
  });
});

it('[AC-B2-11b#34] ⑧ Y、Z、W 为 0 时对应预警项不启用（含分母为 0 的提现额项）', () => {
  const value = passing();
  value.config.warn.high_commission_order_ratio_bp = 0;
  value.config.warn.invalid_ratio_bp = 0;
  value.config.warn.withdraw_received_ratio_bp = 0;
  value.warn_actuals = {
    high_commission_order_ratio_bp: 10000,
    invalid_ratio_bp: 10000,
    withdraw_received_ratio_bp: 999_999,
  };
  expect(failed(value)).toEqual([]);
  value.warn_actuals.withdraw_received_ratio_bp = null;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#35] ⑧ 默认 10000 / 10000 / 10000 / 0：占比满 100% 与分母为 0 都不命中，warn_values 照记', () => {
  const value = passing();
  value.warn_actuals = {
    high_commission_order_ratio_bp: 10000,
    invalid_ratio_bp: 10000,
    withdraw_received_ratio_bp: null,
  };
  expect(decideAutoPayout(value)).toEqual({
    result: 'auto',
    failed_conditions: [],
    warn_values: {
      high_commission_order_ratio_bp: 10000,
      invalid_ratio_bp: 10000,
      withdraw_received_ratio_bp: null,
    },
  });
});

it('[AC-B2-11b#36] ⑧ 三项同时命中按 高佣 → 失效 → 提现额 排列，warn_values 记实际值', () => {
  const value = passing();
  value.config.warn.high_commission_order_ratio_bp = 5000;
  value.config.warn.invalid_ratio_bp = 3000;
  value.config.warn.withdraw_received_ratio_bp = 10000;
  value.warn_actuals = {
    high_commission_order_ratio_bp: 6000,
    invalid_ratio_bp: 4000,
    withdraw_received_ratio_bp: 15625,
  };
  expect(decideAutoPayout(value)).toEqual({
    result: 'manual',
    failed_conditions: ['warn_high_commission', 'warn_invalid_ratio', 'warn_withdraw_received'],
    warn_values: {
      high_commission_order_ratio_bp: 6000,
      invalid_ratio_bp: 4000,
      withdraw_received_ratio_bp: 15625,
    },
  });
});

it('[AC-B2-11b#37] ⑨ 全平台当日自动合计（含本单）≤ 上限：恰好等于通过，多 1 分转人工', () => {
  const value = passing();
  value.platform_daily_auto_fen = 200000n - value.amount_fen;
  expect(failed(value)).toEqual([]);
  value.platform_daily_auto_fen = 200000n - value.amount_fen + 1n;
  expect(failed(value)).toEqual(['platform_daily_max']);
  value.platform_daily_auto_fen = 0n;
  value.config.platform_daily_max_fen = value.amount_fen - 1n;
  expect(failed(value)).toEqual(['platform_daily_max']);
});

it('[AC-B2-11b#38] ⑨ 大额精确比较（超过 2^53 分不丢精度）', () => {
  const value = passing();
  value.config.platform_daily_max_fen = 2n ** 53n + 28001n;
  value.platform_daily_auto_fen = 2n ** 53n + 1n;
  expect(failed(value)).toEqual([]);
  value.platform_daily_auto_fen = 2n ** 53n + 2n;
  expect(failed(value)).toEqual(['platform_daily_max']);
});

it('[AC-B2-11b#39] ⑩ 未满 18 周岁 → minor；已成年不记', () => {
  const value = passing();
  value.adult = false;
  expect(failed(value)).toEqual(['minor']);
  value.adult = true;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#40] ⑪ 快照收款方式对应通道未开通 → channel_disabled', () => {
  const value = passing();
  value.channel_enabled = false;
  expect(failed(value)).toEqual(['channel_disabled']);
  value.channel_enabled = true;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#41] ⑬ W2 守卫不通过 → w2_guard', () => {
  const value = passing();
  value.w2_guard_passed = false;
  expect(failed(value)).toEqual(['w2_guard']);
  value.w2_guard_passed = true;
  expect(failed(value)).toEqual([]);
});

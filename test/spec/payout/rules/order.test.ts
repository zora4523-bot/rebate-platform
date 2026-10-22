import { expect, it } from 'vitest';
import {
  validateWithdrawal,
  withdrawalRules,
  type WithdrawRuleInput,
} from '../../../../apps/api/src/modules/payout/domain/withdraw-rules.ts';
import { input } from './fixtures.ts';

// Each mutation independently triggers one step at amount=10000, net=10000.
const steps: readonly {
  name: string;
  mutate: (value: WithdrawRuleInput) => void;
  code: number;
  data: Record<string, string | bigint>;
  rules: boolean;
}[] = [
  {
    name: '① off',
    mutate: (v) => {
      v.limits.enabled = false;
    },
    code: 30306,
    data: {},
    rules: true,
  },
  {
    name: '② step-up',
    mutate: (v) => {
      v.step_up_valid = false;
    },
    code: 10003,
    data: {},
    rules: false,
  },
  {
    name: '③ banned',
    mutate: (v) => {
      v.risk_state = 'banned';
    },
    code: 10006,
    data: {},
    rules: true,
  },
  {
    name: '③a blacklist',
    mutate: (v) => {
      v.blocklist_risk_msg_code = 'synthetic_block';
    },
    code: 44001,
    data: { risk_msg_code: 'synthetic_block' },
    rules: true,
  },
  {
    name: '③b reverify',
    mutate: (v) => {
      v.reverify = { code: 10010, data: { method: 'sms' } };
    },
    code: 10010,
    data: { method: 'sms' },
    rules: true,
  },
  {
    name: '④ realname',
    mutate: (v) => {
      v.realname_verified = false;
    },
    code: 30304,
    data: {},
    rules: true,
  },
  {
    name: '⑤ payee',
    mutate: (v) => {
      v.payout_method = null;
    },
    code: 30305,
    data: {},
    rules: true,
  },
  {
    name: '⑥ name',
    mutate: (v) => {
      v.names_match = false;
    },
    code: 30307,
    data: {},
    rules: true,
  },
  {
    name: '⑥a labor',
    mutate: (v) => {
      v.labor_agreement_signed = false;
    },
    code: 10004,
    data: { consent_type: 'labor_agreement' },
    rules: true,
  },
  {
    name: '⑦ hold',
    mutate: (v) => {
      v.active_hold = true;
    },
    code: 30303,
    data: { reason: 'account_frozen' },
    rules: true,
  },
  {
    name: '⑧ negative',
    mutate: (v) => {
      v.available_fen = -1n;
    },
    code: 30302,
    data: {},
    rules: true,
  },
  {
    name: '⑨ amount',
    mutate: (v) => {
      v.limits.min_amount_fen = 10100n;
    },
    code: 30303,
    data: { reason: 'below_min' },
    rules: false,
  },
  {
    name: '⑩ balance',
    mutate: (v) => {
      v.available_fen = 9900n;
    },
    code: 30301,
    data: {},
    rules: false,
  },
  {
    name: '⑪ counts',
    mutate: (v) => {
      v.usage.daily_count = 1;
    },
    code: 30303,
    data: { reason: 'daily_count' },
    rules: true,
  },
  {
    name: '⑫ minor',
    mutate: (v) => {
      v.minor = true;
      v.usage.monthly_amount_fen = 10100n;
    },
    code: 30309,
    data: { remaining_fen: 9900n },
    rules: false,
  },
  {
    name: '⑬ purchase',
    mutate: (v) => {
      v.limits.self_purchase_enabled = true;
    },
    code: 30303,
    data: { reason: 'self_purchase_required' },
    rules: true,
  },
];

it.each(steps)('[AC-B2-05c#1] 单步 $name 的错误码和附加数据', ({ mutate, code, data }) => {
  const value = input();
  mutate(value);
  expect(validateWithdrawal(value, 10000n, 10000n)).toEqual({ code, data });
});

const pairs = steps.flatMap((first, i) =>
  steps.slice(i + 1).map((second) => ({ first, second, name: `${first.name} < ${second.name}` })),
);
it.each(pairs)('[AC-B2-05c#2] 两步冲突固定取最前：$name', ({ first, second }) => {
  const value = input();
  second.mutate(value);
  first.mutate(value);
  expect(validateWithdrawal(value, 10000n, 10000n)).toEqual({ code: first.code, data: first.data });
});

it.each(steps.filter((s) => s.rules))(
  '[AC-B2-05c#3] rules 保留 $name，阻断后 max=0、非 30303 的 reason=null',
  ({ mutate, code, data }) => {
    const value = input();
    mutate(value);
    expect(withdrawalRules(value)).toMatchObject({
      can_withdraw: false,
      block_code: code,
      block_reason: code === 30303 ? data['reason'] : null,
      max_withdrawable_fen: 0n,
    });
  },
);

it.each(pairs.filter((p) => p.first.rules && p.second.rules))(
  '[AC-B2-05c#4] rules 同一顺序：$name',
  ({ first, second }) => {
    const value = input();
    second.mutate(value);
    first.mutate(value);
    expect(withdrawalRules(value)).toMatchObject({
      can_withdraw: false,
      block_code: first.code,
      block_reason: first.code === 30303 ? first.data['reason'] : null,
    });
  },
);

it.each([
  ['frozen', null, 30303, { reason: 'account_frozen' }],
  ['appealing', 'frozen', 30303, { reason: 'account_frozen' }],
  ['appealing', 'banned', 10006, {}],
] as const)('[AC-B2-05c#5] BR-WDR-05 %s / prev=%s 的阻断效果', (state, prev, code, data) => {
  const value = input();
  value.risk_state = state;
  value.prev_risk_state = prev;
  expect(validateWithdrawal(value, 100n, 100n)).toEqual({ code, data });
});

it('[AC-B2-05c#6] null 加验端口不阻断；rules 跳过 step-up，提交仍拦截', () => {
  const value = input();
  value.step_up_valid = false;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: true,
    block_code: null,
    block_reason: null,
  });
  expect(validateWithdrawal(value, 100n, 100n)).toEqual({ code: 10003, data: {} });
});

it.each([
  { amount: 50n, min: 100n, max: 500000n, method: 0n, net: 0n, reason: 'below_min' },
  { amount: 500050n, min: 100n, max: 500000n, method: 20000n, net: 0n, reason: 'not_multiple' },
  { amount: 500100n, min: 100n, max: 500000n, method: 20000n, net: 0n, reason: 'above_max' },
  { amount: 20100n, min: 100n, max: 500000n, method: 20000n, net: 0n, reason: 'above_method_max' },
  { amount: 20000n, min: 100n, max: 500000n, method: 20000n, net: 0n, reason: 'net_too_small' },
])('[AC-B2-05c#7] ⑨ 步内优先级 $reason', (row) => {
  const value = input();
  value.limits.min_amount_fen = row.min;
  value.limits.max_amount_fen = row.max;
  value.limits.method_max_amount_fen = { alipay: row.method, bank_card: 0n, wechat: 0n };
  expect(validateWithdrawal(value, row.amount, row.net)).toEqual({
    code: 30303,
    data: { reason: row.reason },
  });
});

it.each([100n, 500000n])('[AC-B2-05c#8] 最低额与单笔上限含等号、净额 1 分允许：%s', (amount) => {
  expect(validateWithdrawal(input(), amount, 1n)).toBeNull();
});

it.each([
  [1, 10, 2, 1, 'daily_count'],
  [0, 10, 2, 1, 'monthly_count'],
  [0, 0, 2, 1, 'payee_daily_count'],
  [0, 0, 0, 1, 'payee_daily_users'],
] as const)(
  '[AC-B2-05c#9] ⑪ 步内优先级（%s,%s,%s,%s）→%s',
  (daily, monthly, payee, others, reason) => {
    const value = input();
    value.usage = {
      daily_count: daily,
      monthly_count: monthly,
      payee_daily_count: payee,
      payee_daily_other_users: others,
      monthly_amount_fen: 0n,
    };
    expect(validateWithdrawal(value, 100n, 100n)).toEqual({ code: 30303, data: { reason } });
  },
);

it('[AC-B2-05c#10] 四个计数配置为 0 均不限；界面剩余次数按任务约定为 9999', () => {
  const value = input();
  Object.assign(value.limits, {
    daily_count_per_user: 0,
    monthly_count_per_user: 0,
    payee_daily_count: 0,
    payee_daily_distinct_users: 0,
  });
  Object.assign(value.usage, {
    daily_count: 20000,
    monthly_count: 20000,
    payee_daily_count: 20000,
    payee_daily_other_users: 20000,
  });
  expect(validateWithdrawal(value, 100n, 100n)).toBeNull();
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: true,
    daily_remaining: 9999,
    monthly_remaining: 9999,
  });
});

it('[AC-B2-05c#11] 已用数 + 本次恰好上限可过；同一会员旧单不增加跨会员人数', () => {
  const value = input();
  value.usage.monthly_count = 9;
  value.usage.payee_daily_count = 1;
  expect(validateWithdrawal(value, 100n, 100n)).toBeNull();
  expect(withdrawalRules(value)).toMatchObject({ daily_remaining: 1, monthly_remaining: 1 });
});

it('[AC-B2-05c#12] 超限时剩余次数钳到 0，不出现负值', () => {
  const value = input();
  value.usage.daily_count = 5;
  value.usage.monthly_count = 11;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: false,
    daily_remaining: 0,
    monthly_remaining: 0,
    max_withdrawable_fen: 0n,
  });
});

it.each([
  ['daily_count_per_user', 'daily_count', 3, 'daily_count'],
  ['monthly_count_per_user', 'monthly_count', 12, 'monthly_count'],
  ['payee_daily_count', 'payee_daily_count', 5, 'payee_daily_count'],
  ['payee_daily_distinct_users', 'payee_daily_other_users', 2, 'payee_daily_users'],
] as const)('[AC-B2-05c#16] 配置 %s=%s 的计数边界随配置改变', (key, usedKey, cap, reason) => {
  const value = input();
  value.limits[key] = cap;
  value.usage[usedKey] = cap - 1;
  expect(validateWithdrawal(value, 100n, 100n)).toBeNull();
  value.usage[usedKey] = cap;
  expect(validateWithdrawal(value, 100n, 100n)).toEqual({ code: 30303, data: { reason } });
});

it('[AC-B2-05c#17] 未成年自定义月额度即时生效，不硬编码默认 20000 分', () => {
  const value = input();
  value.minor = true;
  value.limits.minor_monthly_cap_fen = 1000n;
  value.usage.monthly_amount_fen = 700n;
  expect(validateWithdrawal(value, 300n, 300n)).toBeNull();
  expect(validateWithdrawal(value, 400n, 400n)).toEqual({
    code: 30309,
    data: { remaining_fen: 300n },
  });
  expect(withdrawalRules(value)).toMatchObject({ can_withdraw: true, max_withdrawable_fen: 300n });
});

it.each([
  { cap: 20000n, used: 19900n, amount: 100n, expected: null },
  {
    cap: 20000n,
    used: 19900n,
    amount: 200n,
    expected: { code: 30309, data: { remaining_fen: 100n } },
  },
  {
    cap: 20000n,
    used: 20100n,
    amount: 100n,
    expected: { code: 30309, data: { remaining_fen: 0n } },
  },
  { cap: 0n, used: 0n, amount: 100n, expected: { code: 30309, data: { remaining_fen: 0n } } },
])('[AC-B2-05c#13] 未成年 cap=$cap 已用=$used 本次=$amount', ({ cap, used, amount, expected }) => {
  const value = input();
  value.minor = true;
  value.limits.minor_monthly_cap_fen = cap;
  value.usage.monthly_amount_fen = used;
  expect(validateWithdrawal(value, amount, amount)).toEqual(expected);
});

it('[AC-B2-05c#14] cap=0 一律禁提未成年，rules 仍返回 30309；成年不受该配置限制', () => {
  const value = input();
  value.minor = true;
  value.limits.minor_monthly_cap_fen = 0n;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: false,
    block_code: 30309,
    block_reason: null,
  });
  value.minor = false;
  expect(validateWithdrawal(value, 100n, 100n)).toBeNull();
  expect(withdrawalRules(value)).toMatchObject({ can_withdraw: true });
});

it.each([
  [false, 0, 0n, 0n, null],
  [true, 0, 0n, 0n, 'self_purchase_required'],
  [true, 1, 0n, 0n, null],
  [true, 1, 99n, 100n, 'self_purchase_required'],
  [true, 1, 100n, 100n, null],
] as const)(
  '[AC-B2-05c#15] 自购门槛开关=%s 笔数=%s 金额=%s 阈值=%s',
  (enabled, count, amount, min, reason) => {
    const value = input();
    value.limits.self_purchase_enabled = enabled;
    value.limits.self_purchase_min_fen = min;
    value.self_purchase_count = count;
    value.self_purchase_fen = amount;
    expect(validateWithdrawal(value, 100n, 100n)).toEqual(
      reason === null ? null : { code: 30303, data: { reason } },
    );
  },
);

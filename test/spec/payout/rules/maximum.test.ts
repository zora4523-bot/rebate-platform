import { expect, it } from 'vitest';
import { withdrawalRules } from '../../../../apps/api/src/modules/payout/domain/withdraw-rules.ts';
import { input } from './fixtures.ts';

it.each([
  {
    label: '余额',
    available: 12345n,
    max: 500000n,
    method: 0n,
    minor: false,
    used: 0n,
    expected: 12300n,
  },
  {
    label: '全局上限',
    available: 800000n,
    max: 45678n,
    method: 0n,
    minor: false,
    used: 0n,
    expected: 45600n,
  },
  {
    label: '方式上限',
    available: 800000n,
    max: 500000n,
    method: 19876n,
    minor: false,
    used: 0n,
    expected: 19800n,
  },
  {
    label: '未成年额度',
    available: 800000n,
    max: 500000n,
    method: 0n,
    minor: true,
    used: 7654n,
    expected: 12300n,
  },
  {
    label: '四者同时存在',
    available: 19000n,
    max: 18000n,
    method: 17000n,
    minor: true,
    used: 5001n,
    expected: 14900n,
  },
  {
    label: '未成年人额度不是成年人上限',
    available: 800000n,
    max: 500000n,
    method: 0n,
    minor: false,
    used: 999999n,
    expected: 500000n,
  },
])('[AC-B2-05c#20] max 四个上界分别起作用：$label', (row) => {
  const value = input();
  value.available_fen = row.available;
  value.limits.max_amount_fen = row.max;
  value.limits.method_max_amount_fen = { alipay: row.method, bank_card: 0n, wechat: 20000n };
  value.minor = row.minor;
  value.usage.monthly_amount_fen = row.used;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: true,
    block_code: null,
    block_reason: null,
    max_withdrawable_fen: row.expected,
    withdrawable_fen: row.available,
  });
});

it.each(['alipay', 'bank_card', 'wechat'] as const)('[AC-B2-05c#21] 方式 %s 默认上限', (method) => {
  const value = input();
  value.payout_method = method;
  expect(withdrawalRules(value).max_withdrawable_fen).toBe(method === 'wechat' ? 20000n : 500000n);
});

it.each([0n, 1n, 99n])('[AC-B2-05c#22] 余额 %s 无法凑最低额时 below_min、max=0', (available) => {
  const value = input();
  value.available_fen = available;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: false,
    block_code: 30303,
    block_reason: 'below_min',
    max_withdrawable_fen: 0n,
  });
});

it('[AC-B2-05c#23] 最低额不是步长倍数，先 floor 后再比较 min', () => {
  const value = input();
  value.available_fen = 175n;
  value.limits.min_amount_fen = 150n;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: false,
    block_reason: 'below_min',
    max_withdrawable_fen: 0n,
  });
});

it('[AC-B2-05c#24] 任意整数步长按 0 起点向下取整，不按 min 对齐或四舍五入', () => {
  const value = input();
  value.available_fen = 1124n;
  value.limits.amount_step_fen = 250n;
  value.limits.min_amount_fen = 100n;
  expect(withdrawalRules(value).max_withdrawable_fen).toBe(1000n);
});

it('[AC-B2-05c#25] 月额度剩余不足 min 的 rules 返回 below_min（跳过本次金额比较）', () => {
  const value = input();
  value.minor = true;
  value.usage.monthly_amount_fen = 19901n;
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: false,
    block_code: 30303,
    block_reason: 'below_min',
    max_withdrawable_fen: 0n,
  });
});

it('[AC-B2-05c#26] 最低可提金额不足不会盖过原顺序中的次数或自购阻断', () => {
  const value = input();
  value.available_fen = 99n;
  value.usage.daily_count = 1;
  expect(withdrawalRules(value)).toMatchObject({ block_code: 30303, block_reason: 'daily_count' });
  value.usage.daily_count = 0;
  value.limits.self_purchase_enabled = true;
  expect(withdrawalRules(value)).toMatchObject({
    block_code: 30303,
    block_reason: 'self_purchase_required',
  });
});

it('[AC-B2-05c#27] 微信方式上限改为 0 后只受全局上限，不继续套默认 20000', () => {
  const value = input();
  value.payout_method = 'wechat';
  value.limits.method_max_amount_fen = { alipay: 0n, bank_card: 0n, wechat: 0n };
  expect(withdrawalRules(value)).toMatchObject({
    can_withdraw: true,
    max_withdrawable_fen: 500000n,
  });
});

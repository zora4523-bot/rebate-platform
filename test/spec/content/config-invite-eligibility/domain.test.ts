// F1-02zze §9.2–9.3: independent expected values; never derive the oracle from the registry.
import { expect, it, vi } from 'vitest';
import { deriveInviteEligibilityDays } from '../../../../apps/api/src/modules/content/domain/invite-eligibility.ts';
import { deriveInviteReward } from '../../../../apps/api/src/modules/content/domain/client-config.ts';

const KEY = 'growth.invite_reward.eligibility_days';

it('[AC-F1-02zze#1] 缺行默认 30，忽略 invite 同名键，不报 invalid 或 missing', () => {
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const values = new Map<string, unknown>([['invite.eligibility_days', 7]]);
  expect(deriveInviteEligibilityDays(values, report)).toBe(30);
  expect(report.invalid).not.toHaveBeenCalled();
  expect(report.missing).not.toHaveBeenCalled();
});

it.each([1, 2, 30, 45, 3649, 3650])(
  '[AC-F1-02zze#2] 合法整数 %s 原样返回，不报 invalid 或 missing',
  (days) => {
    const report = { invalid: vi.fn(), missing: vi.fn() };
    const values = new Map<string, unknown>([
      [KEY, days],
      ['invite.eligibility_days', 7],
    ]);
    expect(deriveInviteEligibilityDays(values, report)).toBe(days);
    expect(report.invalid).not.toHaveBeenCalled();
    expect(report.missing).not.toHaveBeenCalled();
  },
);

it.each([
  ['零', 0],
  ['负数', -1],
  ['超过上限', 3651],
  ['int32 上限', 2147483647],
  ['非安全整数', Number.MAX_SAFE_INTEGER + 1],
  ['小数', 30.5],
  ['NaN', Number.NaN],
  ['正无穷', Number.POSITIVE_INFINITY],
  ['负无穷', Number.NEGATIVE_INFINITY],
  ['字符串', '30'],
  ['null', null],
  ['true', true],
  ['false', false],
  ['数组', []],
  ['对象', {}],
  ['存在但 undefined', undefined],
] satisfies [string, unknown][])(
  '[AC-F1-02zze#3] 非法值%s回退 30，仅对资格键 invalid 一次，从不 missing',
  (_label, value) => {
    const report = { invalid: vi.fn(), missing: vi.fn() };
    expect(deriveInviteEligibilityDays(new Map([[KEY, value]]), report)).toBe(30);
    expect(report.invalid.mock.calls).toEqual([[KEY]]);
    expect(report.missing).not.toHaveBeenCalled();
  },
);

it('[AC-F1-02zze#4] 新派生不改奖励函数的两键返回及既有参数', () => {
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const values = new Map<string, unknown>([
    [KEY, 45],
    ['growth.invite_reward.enabled', true],
    ['growth.invite_reward.amount_fen', 500],
  ]);
  expect(deriveInviteEligibilityDays(values, report)).toBe(45);
  expect(deriveInviteReward({ values, availableBudgetFen: 1000, report })).toEqual({
    reward_enabled: true,
    reward_amount_fen: 500,
  });
  expect(deriveInviteReward({ values, availableBudgetFen: 999, report })).toEqual({
    reward_enabled: false,
    reward_amount_fen: 500,
  });
  expect(report.invalid).not.toHaveBeenCalled();
  expect(report.missing).not.toHaveBeenCalled();
});

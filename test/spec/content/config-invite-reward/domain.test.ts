// F1-02zp §9.2–9.3 / BR-INV-24: content consumes a total available budget, not daily spend.
import { expect, it, vi } from 'vitest';
import { deriveInviteReward } from '../../../../apps/api/src/modules/content/domain/client-config.ts';

const ENABLED = 'growth.invite_reward.enabled';
const AMOUNT = 'growth.invite_reward.amount_fen';

function derive(values: Record<string, unknown>, availableBudgetFen: number | null | undefined) {
  const report = { missing: vi.fn(), invalid: vi.fn() };
  const reward = deriveInviteReward({
    values: new Map(Object.entries(values)),
    availableBudgetFen,
    report,
  });
  return { reward, report };
}

it.each([
  ['缺失', {}, []],
  ['false', { [ENABLED]: false }, []],
  ['字符串 true', { [ENABLED]: 'true' }, [ENABLED]],
  ['数字 1', { [ENABLED]: 1 }, [ENABLED]],
  ['字符串 on', { [ENABLED]: 'on' }, [ENABLED]],
  ['null', { [ENABLED]: null }, [ENABLED]],
  ['对象', { [ENABLED]: {} }, [ENABLED]],
] satisfies [string, Record<string, unknown>, string[]][])(
  '[AC-F1-02zp#1] 开关%s按 off，金额仍下发，只有非布尔开关报告非法',
  (_label, values, invalid) => {
    const { reward, report } = derive(values, 2000);
    expect(reward).toEqual({ reward_enabled: false, reward_amount_fen: 1000 });
    expect(report.invalid.mock.calls).toEqual(invalid.map((key) => [key]));
    expect(report.missing).not.toHaveBeenCalled();
  },
);

it.each([
  ['未装配', undefined, false],
  ['无法计算', null, false],
  ['非整数', 1.5, false],
  ['大于阈值的非整数', 2000.5, false],
  ['NaN', Number.NaN, false],
  ['无限大', Number.POSITIVE_INFINITY, false],
  ['负数', -1, false],
  ['零', 0, false],
  ['只够单方', 1000, false],
  ['差一分', 1999, false],
  ['恰好两方', 2000, true],
  ['超过两方', 2001, true],
] satisfies [string, number | null | undefined, boolean][])(
  '[AC-F1-02zp#2] 开关 true，总预算可用额%s时按双方面额判定',
  (_label, available, enabled) => {
    const { reward, report } = derive({ [ENABLED]: true }, available);
    expect(reward).toEqual({ reward_enabled: enabled, reward_amount_fen: 1000 });
    expect(report.invalid).not.toHaveBeenCalled();
    expect(report.missing).not.toHaveBeenCalled();
  },
);

it.each([
  ['负数', -1],
  ['超过 int32', 2147483648],
  ['字符串', '1000'],
  ['小数', 10.5],
  ['null', null],
  ['布尔', true],
  ['数组', []],
  ['对象', {}],
] satisfies [string, unknown][])(
  '[AC-F1-02zp#3] 金额%s回退每方 1000 分，报告键名，并以回退值计算门槛',
  (_label, amount) => {
    for (const [available, enabled] of [
      [1999, false],
      [2000, true],
    ] as const) {
      const { reward, report } = derive({ [ENABLED]: true, [AMOUNT]: amount }, available);
      expect(reward).toEqual({ reward_enabled: enabled, reward_amount_fen: 1000 });
      expect(report.invalid.mock.calls).toEqual([[AMOUNT]]);
      expect(report.missing).not.toHaveBeenCalled();
    }
  },
);

it.each([
  [0, -1, false],
  [0, 0, true],
  [0, null, false],
  [0, undefined, false],
  [500, 999, false],
  [500, 1000, true],
  [2147483647, 4294967293, false],
  [2147483647, 4294967294, true],
] satisfies [number, number | null | undefined, boolean][])(
  '[AC-F1-02zp#4] 合法金额 %s、总预算可用额 %s 的结果为 %s，双方面额不截成 int32',
  (amount, available, enabled) => {
    const { reward, report } = derive({ [ENABLED]: true, [AMOUNT]: amount }, available);
    expect(reward).toEqual({ reward_enabled: enabled, reward_amount_fen: amount });
    expect(report.invalid).not.toHaveBeenCalled();
    expect(report.missing).not.toHaveBeenCalled();
  },
);

it('[AC-F1-02zp#5] 不从 invite 同名键或每日预算派生，off 仍下发合法金额', () => {
  const poison = {
    'invite.reward_enabled': true,
    'invite.reward_amount_fen': 1,
    'growth.invite_reward.daily_budget_fen': 999999,
    'growth.invite_reward.total_budget_fen': 999999,
  };
  expect(derive(poison, 2000).reward).toEqual({
    reward_enabled: false,
    reward_amount_fen: 1000,
  });
  expect(derive({ ...poison, [ENABLED]: true }, 1999).reward).toEqual({
    reward_enabled: false,
    reward_amount_fen: 1000,
  });
  const { reward, report } = derive({ ...poison, [ENABLED]: false, [AMOUNT]: 500 }, 999999);
  expect(reward).toEqual({ reward_enabled: false, reward_amount_fen: 500 });
  expect(report.invalid).not.toHaveBeenCalled();
});

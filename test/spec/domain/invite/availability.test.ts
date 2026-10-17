import { inviterUnavailable, type InviterFacts } from '@couli/domain';
import { expect, it } from 'vitest';

const available: InviterFacts = {
  risk_state: 'normal',
  deletion_status: null,
  phone_bound: true,
  verified_minor: false,
};

// verified_minor 已由调用方计算；未实名按成年传 false，生日算法不属于本任务。
const riskCases = [
  ['normal', false],
  ['frozen', true],
  ['appealing', true],
  ['banned', true],
] as const;
const deletionCases = [
  [null, false],
  ['cancelled', false],
  ['cooling', true],
  ['processing', true],
  ['done', true],
] as const;
const combinations = riskCases.flatMap(([risk_state, riskBlocked]) =>
  deletionCases.flatMap(([deletion_status, deletionBlocked]) =>
    [false, true].flatMap((phone_bound) =>
      [false, true].map((verified_minor) => ({
        facts: { risk_state, deletion_status, phone_bound, verified_minor },
        expected: riskBlocked || deletionBlocked || !phone_bound || verified_minor,
      })),
    ),
  ),
);

it.each(combinations)(
  '[AC-B1-11c#5] BR-INV-02 不可用条件为 OR，当前事实 $facts → $expected',
  ({ facts, expected }) => {
    expect(inviterUnavailable(Object.freeze(facts))).toBe(expected);
  },
);

it('[AC-B1-11c#6] BR-INV-02 每次按当前事实判定，不缓存之前的可用性', () => {
  const facts = { ...available };
  expect(inviterUnavailable(facts)).toBe(false);
  facts.risk_state = 'frozen';
  expect(inviterUnavailable(facts)).toBe(true);
  facts.risk_state = 'normal';
  expect(inviterUnavailable(facts)).toBe(false);
  facts.verified_minor = true;
  expect(inviterUnavailable(facts)).toBe(true);
  facts.verified_minor = false;
  expect(inviterUnavailable(facts)).toBe(false);
});

it.each(['', 'active', 'NORMAL', null, undefined, 0])(
  '[AC-B1-11c#7] 非法 risk_state %j 抛 RangeError',
  (risk_state) => {
    expect(() =>
      inviterUnavailable({ ...available, risk_state } as unknown as InviterFacts),
    ).toThrow(RangeError);
  },
);

it.each(['', 'deleted', 'COOLING', undefined, 0])(
  '[AC-B1-11c#8] 非法 deletion_status %j 抛 RangeError',
  (deletion_status) => {
    expect(() =>
      inviterUnavailable({ ...available, deletion_status } as unknown as InviterFacts),
    ).toThrow(RangeError);
  },
);

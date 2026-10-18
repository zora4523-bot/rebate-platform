import { evidenceEvent, summarizeClaimDecisions } from '@couli/domain';
import { expect, it } from 'vitest';
import { CLAIM, publicExports, transitionFunction } from './kit.ts';

type Decision = 'approved' | 'rejected' | 'cancelled' | null;
type Resolution = 'RESOLVE_APPROVED' | 'RESOLVE_REJECTED' | 'RESOLVE_CANCELLED' | null;
type Evidence = 'strong' | 'weak' | 'none';

// BR-ATTR-18：未决优先阻止结案；全部已决时 approved > rejected > cancelled。
// 独立列出长度 1～3 的全部无序多重集，再展开排列，覆盖 4 + 16 + 64 种输入。
const DECISIONS: { decisions: Decision[]; expected: Resolution }[] = [
  { decisions: [null], expected: null },
  { decisions: ['approved'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['rejected'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['cancelled'], expected: 'RESOLVE_CANCELLED' },
  { decisions: [null, null], expected: null },
  { decisions: [null, 'approved'], expected: null },
  { decisions: [null, 'rejected'], expected: null },
  { decisions: [null, 'cancelled'], expected: null },
  { decisions: ['approved', 'approved'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'rejected'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'cancelled'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['rejected', 'rejected'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['rejected', 'cancelled'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['cancelled', 'cancelled'], expected: 'RESOLVE_CANCELLED' },
  { decisions: [null, null, null], expected: null },
  { decisions: [null, null, 'approved'], expected: null },
  { decisions: [null, null, 'rejected'], expected: null },
  { decisions: [null, null, 'cancelled'], expected: null },
  { decisions: [null, 'approved', 'approved'], expected: null },
  { decisions: [null, 'approved', 'rejected'], expected: null },
  { decisions: [null, 'approved', 'cancelled'], expected: null },
  { decisions: [null, 'rejected', 'rejected'], expected: null },
  { decisions: [null, 'rejected', 'cancelled'], expected: null },
  { decisions: [null, 'cancelled', 'cancelled'], expected: null },
  { decisions: ['approved', 'approved', 'approved'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'approved', 'rejected'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'approved', 'cancelled'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'rejected', 'rejected'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'rejected', 'cancelled'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['approved', 'cancelled', 'cancelled'], expected: 'RESOLVE_APPROVED' },
  { decisions: ['rejected', 'rejected', 'rejected'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['rejected', 'rejected', 'cancelled'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['rejected', 'cancelled', 'cancelled'], expected: 'RESOLVE_REJECTED' },
  { decisions: ['cancelled', 'cancelled', 'cancelled'], expected: 'RESOLVE_CANCELLED' },
];

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return [...new Set(values)].flatMap((value) => {
    const index = values.indexOf(value);
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    return permutations(rest).map((tail) => [value, ...tail]);
  });
}

const DECISION_CASES = DECISIONS.flatMap(({ decisions, expected }) =>
  permutations(decisions).map((input) => ({ input, expected })),
);

it.each(DECISION_CASES)(
  '[CT-04e#8] 子项 $input 汇总为 $expected，不改写输入',
  ({ input, expected }) => {
    const frozen = Object.freeze([...input]);
    expect(summarizeClaimDecisions(frozen)).toBe(expected);
    expect(frozen).toEqual(input);
  },
);

it('[CT-04e#9] 无子项的 claim 不能按全 cancelled 结案，必须抛 RangeError', () => {
  expect(() => summarizeClaimDecisions([])).toThrow(RangeError);
});

const EVIDENCE_CASES: {
  levels: Evidence[];
  expected: 'EVIDENCE_ALL_STRONG' | 'EVIDENCE_NOT_ALL_STRONG';
}[] = [
  { levels: ['strong'], expected: 'EVIDENCE_ALL_STRONG' },
  { levels: ['strong', 'strong'], expected: 'EVIDENCE_ALL_STRONG' },
  { levels: ['strong', 'strong', 'strong'], expected: 'EVIDENCE_ALL_STRONG' },
  { levels: ['weak'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['weak', 'weak'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['none', 'none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['weak', 'none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['strong', 'weak'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['strong', 'none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['strong', 'strong', 'weak'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['strong', 'strong', 'none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
  { levels: ['strong', 'weak', 'none'], expected: 'EVIDENCE_NOT_ALL_STRONG' },
];

it.each(EVIDENCE_CASES)(
  '[CT-04e#10] 证据 $levels 由最弱子项决定，排列不影响结果',
  ({ levels, expected }) => {
    for (const input of permutations(levels)) {
      const frozen = Object.freeze([...input]);
      expect(evidenceEvent(frozen)).toBe(expected);
      expect(frozen).toEqual(input);
    }
  },
);

it('[CT-04e#11] 无子项不能判为全 strong，必须抛 RangeError', () => {
  expect(() => evidenceEvent([])).toThrow(RangeError);
});

it('[CT-04e#12] BR-ATTR-18 父单 strong + none 待人工审核，通过与驳回混合汇总通过', () => {
  const transition = transitionFunction(publicExports(), CLAIM);
  expect(transition('submitted', evidenceEvent(['strong', 'none']))).toEqual({
    ok: true,
    to: 'manual_review',
    id: 'C3',
    noop: false,
  });
  expect(summarizeClaimDecisions(['approved', null])).toBeNull();
  expect(transition('manual_review', summarizeClaimDecisions(['approved', 'rejected']))).toEqual({
    ok: true,
    to: 'approved',
    id: 'C4',
    noop: false,
  });
});

it('[CT-04e#13] 全 strong 仍待确认，同步先决定一个子项不会提前关闭 claim', () => {
  const transition = transitionFunction(publicExports(), CLAIM);
  expect(transition('submitted', evidenceEvent(['strong', 'strong']))).toEqual({
    ok: true,
    to: 'auto_matched',
    id: 'C2',
    noop: false,
  });
  expect(summarizeClaimDecisions(['cancelled', null])).toBeNull();
  expect(summarizeClaimDecisions(['rejected', null])).toBeNull();
  expect(transition('auto_matched', summarizeClaimDecisions(['cancelled', 'cancelled']))).toEqual({
    ok: true,
    to: 'cancelled',
    id: 'C6',
    noop: false,
  });
  expect(transition('auto_matched', summarizeClaimDecisions(['cancelled', 'rejected']))).toEqual({
    ok: true,
    to: 'rejected',
    id: 'C5',
    noop: false,
  });
});

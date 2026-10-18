// CT-04e 单元测试：汇总函数与 claim 状态机的衔接（规则测试在 test/spec/state-machines/claim/）。
import { expect, it } from 'vitest';
import {
  evidenceEvent,
  summarizeClaimDecisions,
  transitionClaim,
  transitionClaimItem,
} from '../index.ts';

it('[AC-CT-04e-UNIT#1] 子项全部已决时按 approved > rejected > cancelled 汇总', () => {
  expect(summarizeClaimDecisions(['cancelled', 'rejected', 'approved'])).toBe('RESOLVE_APPROVED');
  expect(summarizeClaimDecisions(['cancelled', 'rejected'])).toBe('RESOLVE_REJECTED');
  expect(summarizeClaimDecisions(['cancelled'])).toBe('RESOLVE_CANCELLED');
});

it('[AC-CT-04e-UNIT#2] 还有未决子项返回 null；空数组抛 RangeError', () => {
  expect(summarizeClaimDecisions(['approved', null])).toBeNull();
  expect(() => summarizeClaimDecisions([])).toThrow(RangeError);
  expect(() => evidenceEvent([])).toThrow(RangeError);
});

it('[AC-CT-04e-UNIT#3] 汇总结果可直接喂给 transitionClaim，终态再收事件为表外', () => {
  const evidence = transitionClaim('submitted', evidenceEvent(['strong', 'weak']));
  expect(evidence).toStrictEqual({ ok: true, to: 'manual_review', id: 'C3', noop: false });
  const resolved = transitionClaim('manual_review', 'RESOLVE_REJECTED');
  expect(resolved).toStrictEqual({ ok: true, to: 'rejected', id: 'C5', noop: false });
  expect(transitionClaim('rejected', 'RESOLVE_APPROVED')).toStrictEqual({
    ok: false,
    reason: 'illegal',
    id: null,
  });
});

it('[AC-CT-04e-UNIT#4] 子项只能从待审（null）决定一次，已决不能改判', () => {
  expect(transitionClaimItem(null, 'CANCEL')).toStrictEqual({
    ok: true,
    to: 'cancelled',
    id: 'I3',
    noop: false,
  });
  expect(transitionClaimItem('approved', 'REJECT')).toStrictEqual({
    ok: false,
    reason: 'illegal',
    id: null,
  });
});

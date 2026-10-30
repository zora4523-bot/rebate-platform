// B1-08zc 实现者单元测试：平台恢复的触发与前提判定（规则测试在 test/spec/orders/platform-restore/**）。
import { expect, it } from 'vitest';
import {
  detectPlatformRestore,
  isPlatformRestoreEligible,
  isRestorableRebate,
  type PlatformRestoreChange,
} from './platform-restore.ts';

const QUIET: PlatformRestoreChange = {
  platformBefore: 'PAID',
  platformAfter: 'PAID',
  estBefore: 100n,
  estAfter: 100n,
  settleBefore: null,
  settleAfter: null,
};

it('[AC-B1-08zc#u1] P9 三个去向都是状态触发；金额 SETTLED 取结算佣金、其余取预估佣金，空按 0', () => {
  const invalid = { ...QUIET, platformBefore: 'INVALID', estAfter: 789n };
  expect(detectPlatformRestore({ ...invalid, platformAfter: 'PAID' })).toEqual({
    trigger: 'status',
    expectedFen: 789n,
  });
  expect(detectPlatformRestore({ ...invalid, platformAfter: 'RECEIVED', estAfter: null })).toEqual({
    trigger: 'status',
    expectedFen: 0n,
  });
  expect(
    detectPlatformRestore({ ...invalid, platformAfter: 'SETTLED', settleAfter: 1234n }),
  ).toEqual({ trigger: 'status', expectedFen: 1234n });
  expect(detectPlatformRestore({ ...invalid, platformAfter: 'SETTLED' })).toEqual({
    trigger: 'status',
    expectedFen: 0n,
  });
  // 同时佣金恢复也按状态触发。
  expect(
    detectPlatformRestore({ ...invalid, platformAfter: 'PAID', estBefore: 0n, estAfter: 5n }),
  ).toEqual({ trigger: 'status', expectedFen: 5n });
});

it('[AC-B1-08zc#u2] 非 P9 的状态变化不是状态触发（INVALID 留在 INVALID、PAID → RECEIVED）', () => {
  expect(
    detectPlatformRestore({ ...QUIET, platformBefore: 'INVALID', platformAfter: 'INVALID' }),
  ).toBeNull();
  expect(detectPlatformRestore({ ...QUIET, platformAfter: 'RECEIVED' })).toBeNull();
});

it('[AC-B1-08zc#u3] 佣金触发只认由空或 ≤0 变为严格 >0', () => {
  const cases: readonly [bigint | null, bigint | null, boolean][] = [
    [null, 1n, true],
    [0n, 1n, true],
    [-20n, 610n, true],
    [null, 0n, false],
    [-10n, 0n, false],
    [0n, -10n, false],
    [100n, 200n, false],
    [100n, 0n, false],
    [null, null, false],
  ];
  for (const [before, after, fires] of cases) {
    const est = detectPlatformRestore({ ...QUIET, estBefore: before, estAfter: after });
    expect(est).toEqual(fires ? { trigger: 'commission', expectedFen: after } : null);
    const settle = detectPlatformRestore({
      ...QUIET,
      platformBefore: 'SETTLED',
      platformAfter: 'SETTLED',
      settleBefore: before,
      settleAfter: after,
    });
    expect(settle).toEqual(fires ? { trigger: 'commission', expectedFen: after } : null);
  }
});

it('[AC-B1-08zc#u4] 两列同时恢复时金额取结算佣金', () => {
  expect(
    detectPlatformRestore({
      ...QUIET,
      platformBefore: 'SETTLED',
      platformAfter: 'SETTLED',
      estBefore: 0n,
      estAfter: 50n,
      settleBefore: 0n,
      settleAfter: 40n,
    }),
  ).toEqual({ trigger: 'commission', expectedFen: 40n });
});

it('[AC-B1-08zc#u5] 前提：VOID / CLAWED_BACK 且 reason 属 (i) 或进入事件属 (ii)；PUNISH / BLACKLIST 与其他状态不成立', () => {
  expect(isRestorableRebate('VOID')).toBe(true);
  expect(isRestorableRebate('CLAWED_BACK')).toBe(true);
  expect(isRestorableRebate('CREDITED')).toBe(false);
  for (const reason of ['REFUND', 'RIGHTS', 'COMMISSION_ZERO']) {
    expect(isPlatformRestoreEligible({ rebateStatus: 'VOID', reason, entryEvent: null })).toBe(
      true,
    );
  }
  for (const entryEvent of ['PLATFORM_INVALID', 'INVALID_AFTER_SETTLE']) {
    expect(
      isPlatformRestoreEligible({ rebateStatus: 'CLAWED_BACK', reason: null, entryEvent }),
    ).toBe(true);
  }
  expect(
    isPlatformRestoreEligible({ rebateStatus: 'VOID', reason: 'PUNISH', entryEvent: 'PUNISH' }),
  ).toBe(false);
  expect(
    isPlatformRestoreEligible({
      rebateStatus: 'VOID',
      reason: 'BLACKLIST',
      entryEvent: 'BLACKLIST_HIT',
    }),
  ).toBe(false);
  expect(
    isPlatformRestoreEligible({
      rebateStatus: 'WAITING',
      reason: 'REFUND',
      entryEvent: 'PLATFORM_INVALID',
    }),
  ).toBe(false);
});

import { expect, it } from 'vitest';
import {
  creditEnabledValue,
  earlierPeriod,
  effectiveCommissionFen,
  integerConfig,
  pendingBaseFen,
  splitPendingShares,
} from './pending-earnings-rules.ts';

it('[AC-B2-04x-UNIT#1] 结算佣金非空（含 0、负数）时优先，否则取预估，两者都空为未知', () => {
  expect(effectiveCommissionFen(9999n, 0n)).toBe(0n);
  expect(effectiveCommissionFen(9999n, -1n)).toBe(-1n);
  expect(effectiveCommissionFen(1001n, null)).toBe(1001n);
  expect(effectiveCommissionFen(null, null)).toBeNull();
});

it('[AC-B2-04x-UNIT#2] 基数先扣预留再扣淘礼金，负数与超扣钳到 0', () => {
  expect(pendingBaseFen(1001n, 1500, 0n)).toBe(850n);
  expect(pendingBaseFen(1001n, 1500, 101n)).toBe(749n);
  expect(pendingBaseFen(1001n, 1500, 851n)).toBe(0n);
  expect(pendingBaseFen(-5n, 0, 0n)).toBe(0n);
  expect(pendingBaseFen(1001n, 10000, 0n)).toBe(0n);
});

it('[AC-B2-04x-UNIT#3] 逐角色向下取整，初始 forfeited 与 forfeited 事件的角色剔除', () => {
  const shares = splitPendingShares(
    850n,
    [
      { userId: 'a', role: 'self', ratioBp: 5000, initialStatus: 'active' },
      { userId: 'b', role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
      { userId: 'c', role: 'indirect', ratioBp: 500, initialStatus: 'active' },
      { userId: 'a', role: 'direct', ratioBp: 1000, initialStatus: 'active' },
    ],
    [{ userId: 'c', role: 'indirect' }],
  );
  expect(shares).toEqual([
    { userId: 'a', role: 'self', amountFen: 425n },
    { userId: 'a', role: 'direct', amountFen: 85n },
  ]);
});

it('[AC-B2-04x-UNIT#4] 开关默认关闭，整数配置未配置取默认、非法值抛错', () => {
  expect(creditEnabledValue(undefined)).toBe(false);
  expect(creditEnabledValue(false)).toBe(false);
  expect(creditEnabledValue('off')).toBe(false);
  expect(creditEnabledValue(true)).toBe(true);
  expect(creditEnabledValue('on')).toBe(true);
  expect(integerConfig(undefined, 'k', 24)).toBe(24);
  expect(integerConfig(0, 'k', 10)).toBe(0);
  expect(integerConfig('22', 'k', 24)).toBe(22);
  expect(() => integerConfig('x', 'k', 24)).toThrow(RangeError);
  expect(() => integerConfig(1.5, 'k', 24)).toThrow(RangeError);
});

it('[AC-B2-04x-UNIT#5] 预计月份取较早者', () => {
  expect(earlierPeriod(null, '2026-11')).toBe('2026-11');
  expect(earlierPeriod('2026-11', '2026-10')).toBe('2026-10');
  expect(earlierPeriod('2026-10', '2027-01')).toBe('2026-10');
});

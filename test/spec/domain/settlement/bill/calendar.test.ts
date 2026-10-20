import {
  canScheduleSettlement,
  isInAssetSnapshotWindow,
  settlementBillPeriod,
} from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  ['2026-11-24T00:01:00+08:00', '2026-10'],
  ['2026-01-24T00:01:00+08:00', '2025-12'],
  ['2026-10-31T15:59:59.999Z', '2026-09'],
  ['2026-10-31T16:00:00.000Z', '2026-10'],
  ['2026-10-31T23:59:59.999Z', '2026-10'],
  ['2026-12-31T15:59:59.999Z', '2026-11'],
  ['2026-12-31T16:00:00.000Z', '2026-12'],
  ['2024-02-29T15:59:59.999Z', '2024-01'],
  ['2024-02-29T16:00:00.000Z', '2024-02'],
  ['2026-02-28T16:00:00.000Z', '2026-02'],
] as const)('[AC-B2-04f#48] 生成名义时刻 %s 的账单月是上一自然月 %s', (at, expected) => {
  expect(settlementBillPeriod(new Date(at))).toBe(expected);
});

// BR-FUND-18 00:30 超时即可执行；因此名义窗口取左闭右开。
it.each([
  ['2026-10-31T23:59:59.999+08:00', false],
  ['2026-11-01T00:00:00.000+08:00', true],
  ['2026-11-01T00:00:59.999+08:00', true],
  ['2026-11-01T00:01:00.000+08:00', true],
  ['2026-11-01T00:29:59.999+08:00', true],
  ['2026-11-01T00:30:00.000+08:00', false],
  ['2026-11-01T07:59:59.999+08:00', false],
  ['2026-11-01T08:00:00.000+08:00', false],
  ['2026-11-01T12:00:00.000+08:00', false],
  ['2026-10-31T16:00:00.000Z', true],
  ['2026-10-31T16:29:59.999Z', true],
  ['2026-10-31T16:30:00.000Z', false],
  ['2026-11-01T00:10:00.000Z', false],
  ['2026-12-31T16:00:00.000Z', true],
  ['2024-02-29T16:00:00.000Z', true],
  ['2026-10-31T09:10:00.000-07:00', true],
] as const)('[AC-B2-04f#49] 名义快照窗口 [00:00,00:30)：%s → %s', (at, expected) => {
  expect(isInAssetSnapshotWindow(new Date(at))).toBe(expected);
});

it.each([
  ['2026-11-24T10:00:00+08:00', '2026-11-24T09:59:59.999+08:00', false],
  ['2026-11-24T10:00:00+08:00', '2026-11-24T10:00:00+08:00', false],
  ['2026-11-24T10:00:00+08:00', '2026-11-24T10:00:00.001+08:00', true],
  ['2026-11-24T10:00:00+08:00', '2026-11-24T02:00:00Z', false],
  ['2026-11-24T23:59:59.999+08:00', '2026-11-25T00:00:00+08:00', false],
  ['2026-11-24T23:59:59.999+08:00', '2026-11-25T00:29:59.999+08:00', false],
  ['2026-11-24T23:59:59.999+08:00', '2026-11-25T00:30:00+08:00', true],
  ['2026-11-25T00:10:00+08:00', '2026-11-25T00:30:00+08:00', true],
  ['2026-11-24T10:00:00+08:00', '2026-11-25T07:59:59.999+08:00', true],
] as const)(
  '[AC-B2-04f#50] 确认 %s、定时 %s：严格晚于且避开快照窗口 → %s',
  (confirmed, scheduled, expected) => {
    expect(canScheduleSettlement(new Date(confirmed), new Date(scheduled))).toBe(expected);
  },
);

it('[AC-B2-04f#51] 时间纯函数不修改输入且交错调用不读系统时钟', () => {
  const at = new Date('2026-12-31T16:29:59.999Z');
  const confirmed = new Date('2026-12-31T15:00:00Z');
  const before = [at.getTime(), confirmed.getTime()];
  const first = [
    settlementBillPeriod(at),
    isInAssetSnapshotWindow(at),
    canScheduleSettlement(confirmed, at),
  ];
  settlementBillPeriod(new Date('2024-02-29T16:00:00Z'));
  expect({
    first,
    again: [
      settlementBillPeriod(at),
      isInAssetSnapshotWindow(at),
      canScheduleSettlement(confirmed, at),
    ],
    instants: [at.getTime(), confirmed.getTime()],
  }).toEqual({
    first: ['2026-12', true, false],
    again: ['2026-12', true, false],
    instants: before,
  });
});

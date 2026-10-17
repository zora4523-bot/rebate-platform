import { inviteBackfillDeadline, withinBackfill } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  ['2026-10-01T10:00:00+08:00', 168, '2026-10-08T10:00:00+08:00'],
  ['2026-10-31T23:59:59.999+08:00', 1, '2026-11-01T00:59:59.999+08:00'],
  ['2026-11-01T00:00:00+08:00', 24, '2026-11-02T00:00:00+08:00'],
  ['2026-10-17T07:59:59.123+08:00', 168, '2026-10-24T07:59:59.123+08:00'],
  ['2026-12-31T23:30:00.456+08:00', 1, '2027-01-01T00:30:00.456+08:00'],
  ['2028-02-28T10:00:00+08:00', 48, '2028-03-01T10:00:00+08:00'],
  ['2026-10-01T10:00:00.999+08:00', 0, '2026-10-01T10:00:00.999+08:00'],
] as const)(
  '[AC-B1-11c#9] BR-INV-07 从 %s 加 %s 小时保留毫秒得到 %s，不修改创建时间',
  (created, hours, expected) => {
    const createdAt = new Date(created);
    const deadline = inviteBackfillDeadline(createdAt, hours);
    expect(deadline).toBeInstanceOf(Date);
    expect(deadline.getTime()).toBe(Date.parse(expected));
    expect(createdAt.getTime()).toBe(Date.parse(created));
  },
);

it.each([
  ['2026-10-08T09:59:59+08:00', true],
  ['2026-10-08T09:59:59.999+08:00', true],
  ['2026-10-08T10:00:00+08:00', false],
  ['2026-10-08T10:00:00.001+08:00', false],
] as const)('[AC-B1-11c#10] BR-INV-07 168 小时补填窗口 %s → %s', (now, expected) => {
  const deadline = inviteBackfillDeadline(new Date('2026-10-01T10:00:00+08:00'), 168);
  expect(withinBackfill(new Date(now), deadline)).toBe(expected);
});

it.each([
  '2026-10-31T23:59:59.999+08:00',
  '2026-11-01T00:00:00+08:00',
  '2026-10-17T07:59:59.123+08:00',
])('[AC-B1-11c#11] 严格比较期限 %s 的前一毫秒、相等、后一毫秒，不修改入参', (iso) => {
  const deadline = new Date(iso);
  const time = Date.parse(iso);
  for (const [delta, expected] of [
    [-1, true],
    [0, false],
    [1, false],
  ] as const) {
    const now = new Date(time + delta);
    expect(withinBackfill(now, deadline)).toBe(expected);
    expect(now.getTime()).toBe(time + delta);
    expect(deadline.getTime()).toBe(time);
  }
});

it.each([0, 1, 86_400_000])('[AC-B1-11c#12] 零小时窗口在创建后 %s 毫秒不可补填', (elapsed) => {
  const created = new Date('2026-10-01T10:00:00.123+08:00');
  const deadline = inviteBackfillDeadline(created, 0);
  expect(withinBackfill(new Date(created.getTime() + elapsed), deadline)).toBe(false);
});

it.each([-1, -0.5, 0.5, 168.5, NaN, Infinity, -Infinity])(
  '[AC-B1-11c#13] 拒绝非有限非负整数小时 %s',
  (hours) => {
    expect(() => inviteBackfillDeadline(new Date('2026-10-01T10:00:00+08:00'), hours)).toThrow(
      RangeError,
    );
  },
);

it('[AC-B1-11c#14] 非法创建时刻抛 RangeError', () => {
  expect(() => inviteBackfillDeadline(new Date(NaN), 168)).toThrow(RangeError);
});

it.each(['now', 'deadline', 'both'])(
  '[AC-B1-11c#15] 比较时 %s 无效必须抛 RangeError，不静默返回 false',
  (invalid) => {
    const valid = Date.parse('2026-10-01T10:00:00+08:00');
    const now = new Date(invalid === 'deadline' ? valid : NaN);
    const deadline = new Date(invalid === 'now' ? valid : NaN);
    expect(() => withinBackfill(now, deadline)).toThrow(RangeError);
  },
);

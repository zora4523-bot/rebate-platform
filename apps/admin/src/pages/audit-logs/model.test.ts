// Unit tests of the audit log helpers (F1-10j): Beijing-time input, filters and difference rows.
import { expect, it } from 'vitest';
import { ABSENT, EMPTY_DRAFT, beijingInput, diffRows, filtersOf, valueText } from './model.ts';

it('[AC-F1-10j-UNIT#1] 北京时间输入转为带 +08:00 的 ISO，非法日期拒绝', () => {
  expect(beijingInput('2026-10-19 00:00:00')).toBe('2026-10-19T00:00:00+08:00');
  expect(beijingInput('2026-10-19')).toBe('2026-10-19T00:00:00+08:00');
  expect(beijingInput('2026-02-30 00:00')).toBeUndefined();
  expect(beijingInput('昨天')).toBeUndefined();
});

it('[AC-F1-10j-UNIT#2] 空白筛选不发，起止颠倒报 range', () => {
  expect(filtersOf({ ...EMPTY_DRAFT, actor: '  ' })).toEqual({ ok: true, filters: {} });
  expect(
    filtersOf({ ...EMPTY_DRAFT, from: '2026-10-20 00:00:00', to: '2026-10-19 00:00:00' }),
  ).toEqual({ ok: false, field: 'from', kind: 'range' });
});

it('[AC-F1-10j-UNIT#3] 差异行按字段并集，缺失一侧为 ABSENT，标量整体一行', () => {
  const rows = diffRows({ a: 1, b: [1] }, { b: [1], c: false });
  expect(rows.map((row) => [row.field, row.changed])).toEqual([
    ['a', true],
    ['b', false],
    ['c', true],
  ]);
  expect(rows[0]!.after).toBe(ABSENT);
  expect(diffRows(null, null)).toEqual([]);
  const whole = diffRows('x', ['y', 0]);
  expect(whole).toHaveLength(1);
  expect(whole[0]!.field).toBeUndefined();
  expect(valueText(whole[0]!.after, '—')).toBe('["y",0]');
  expect(valueText(ABSENT, '—')).toBe('—');
});

// Unit tests of the order helpers (F1-07e): Beijing day bounds, request parameters, basis-point
// percentages, admin amounts and the router state of 【返回】.
import { expect, it } from 'vitest';
import {
  backQueryOf,
  beijingTime,
  dayEnd,
  dayStart,
  money,
  percent,
  requestQuery,
} from './model.ts';

it('[AC-F1-07e-UNIT#1] 付款日期按北京时间：起始日零点含，结束日次日零点不含，跨月跨年', () => {
  expect(dayStart('2026-10-01')).toBe('2026-10-01T00:00:00+08:00');
  expect(dayEnd('2026-10-07')).toBe('2026-10-08T00:00:00+08:00');
  expect(dayEnd('2026-10-31')).toBe('2026-11-01T00:00:00+08:00');
  expect(dayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+08:00');
});

it('[AC-F1-07e-UNIT#2] 请求参数只带已填条件，名称与契约一致', () => {
  expect(requestQuery({ page: 1 })).toEqual({ page: 1, page_size: 20 });
  expect(
    requestQuery({ page: 2, platformStatus: 'SETTLED', flag: 'locked', paidTo: '2026-10-07' }),
  ).toEqual({
    page: 2,
    page_size: 20,
    platform_status: 'SETTLED',
    flag: 'locked',
    paid_to: '2026-10-08T00:00:00+08:00',
  });
});

it('[AC-F1-07e-UNIT#3] 万分之一比例两位百分比、金额后台格式、空值显示短横', () => {
  expect(percent(1234)).toBe('12.34%');
  expect(percent(6000)).toBe('60.00%');
  expect(percent(5)).toBe('0.05%');
  expect(percent(null)).toBe('—');
  expect(money(1234567)).toBe('¥12,345.67');
  expect(money(0)).toBe('¥0.00');
  expect(money(null)).toBe('—');
  expect(beijingTime('2026-10-06T17:05:12Z')).toBe('2026-10-07 01:05:12');
});

it('[AC-F1-07e-UNIT#4] 返回时的路由状态只恢复合法条件', () => {
  expect(backQueryOf(null)).toBeUndefined();
  expect(
    backQueryOf({
      ordersQuery: { page: 3, platform: 'pdd', flag: 'nope', paidFrom: 'x', q: 'A1' },
    }),
  ).toEqual({
    page: 3,
    platform: 'pdd',
    platformStatus: undefined,
    rebateStatus: undefined,
    flag: undefined,
    q: 'A1',
    userId: undefined,
    paidFrom: undefined,
    paidTo: undefined,
  });
});

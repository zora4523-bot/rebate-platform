// Unit tests of the manual sync helpers (F1-07eb): typed Beijing times, order number lines and the
// outcome of a refused request.
import { expect, it } from 'vitest';
import { AdminApiError } from '../../providers/data/index.ts';
import { beijingInput, beijingMinute, orderNosOf, syncFailureOf } from './model.ts';

it('[AC-F1-07eb-UNIT#1] 北京时间输入转成带 +08:00 的时间，非法日期与格式不收', () => {
  expect(beijingInput('2026-10-21 00:00')).toBe('2026-10-21T00:00:00+08:00');
  expect(beijingInput(' 2026-10-20 12:00:30 ')).toBe('2026-10-20T12:00:30+08:00');
  expect(beijingInput('2026-10-20T12:00')).toBe('2026-10-20T12:00:00+08:00');
  expect(beijingInput('2026-02-30 00:00')).toBeUndefined();
  expect(beijingInput('2026-10-21 24:00')).toBeUndefined();
  expect(beijingInput('2026/10/21 00:00')).toBeUndefined();
  expect(beijingInput('')).toBeUndefined();
  expect(beijingMinute('2026-10-18T16:30:00Z')).toBe('2026-10-19 00:30');
});

it('[AC-F1-07eb-UNIT#2] 单号每行一个，去掉首尾空白、空行与重复', () => {
  expect(orderNosOf('  A1\nB2  \n\n')).toEqual(['A1', 'B2']);
  expect(orderNosOf('A1,B2，A1')).toEqual(['A1', 'B2']);
  expect(orderNosOf('  \n \n')).toEqual([]);
});

it('[AC-F1-07eb-UNIT#3] 拒绝码对应结果：20001 字段、30156 平台、10403、429、网络失败', () => {
  const api = (code: number, data: unknown, httpStatus = 400) =>
    new AdminApiError({ code, msg: '', data, httpStatus, kind: 'api' });
  expect(syncFailureOf(api(20001, { fields: ['from', 'to'] }), 'pdd')).toEqual({
    kind: 'fields',
    fields: ['from', 'to'],
  });
  expect(syncFailureOf(api(30156, { platform: 'jd' }, 422), 'pdd')).toEqual({
    kind: 'paused',
    platform: 'jd',
  });
  expect(syncFailureOf(api(10403, null, 403), 'pdd')).toEqual({ kind: 'forbidden' });
  expect(syncFailureOf(api(42901, null, 429), 'pdd')).toEqual({ kind: 'rateLimited' });
  expect(
    syncFailureOf(
      new AdminApiError({ code: -1, msg: '', data: null, httpStatus: 0, kind: 'network' }),
      'pdd',
    ),
  ).toEqual({ kind: 'network' });
  expect(syncFailureOf(new Error('x'), 'pdd')).toEqual({ kind: 'failed' });
});

import { expect, it } from 'vitest';
import { occurredAt } from './validation.ts';

/** What publish puts in occurred_at for `ms` (Date#toISOString of the clock instant). */
function produced(ms: number): string {
  return new Date(ms).toISOString();
}

it('[AC-B1-01zv#4] 消费端接受生产端可能给出的全部时刻文本：0、四位年份最后一刻、第一个扩展年份、2^48−1 毫秒、闰日', () => {
  const values = [
    0,
    253_402_300_799_999,
    253_402_300_800_000,
    2 ** 48 - 1,
    Date.parse('2032-02-29T23:59:59.999Z'),
    Date.parse('2400-02-29T00:00:00.000Z'),
  ].map(produced);
  expect(values.map(occurredAt)).toStrictEqual(values.map(() => true));
  expect(values.slice(2, 4)).toStrictEqual([
    '+010000-01-01T00:00:00.000Z',
    '+010889-08-02T05:31:50.655Z',
  ]);
});

it('[AC-B1-01zv#4] 消费端拒绝生产端给不出的时刻文本：超出 2^48、1970 年前、负年份、不该带符号的四位年份、不存在的日期与时刻、非字符串', () => {
  const values: unknown[] = [
    '+010889-08-02T05:31:50.656Z',
    '+099999-01-01T00:00:00.000Z',
    '1969-12-31T23:59:59.999Z',
    '-000001-01-01T00:00:00.000Z',
    '+002031-02-03T04:05:06.789Z',
    '+009999-12-31T23:59:59.999Z',
    '10000-01-01T00:00:00.000Z',
    '2031-02-29T00:00:00.000Z',
    '2100-02-29T00:00:00.000Z',
    '2031-04-31T00:00:00.000Z',
    '2031-00-10T00:00:00.000Z',
    '2031-13-10T00:00:00.000Z',
    '2031-01-00T00:00:00.000Z',
    '2031-01-01T24:00:00.000Z',
    '2031-01-01T23:60:00.000Z',
    '2031-01-01T23:59:60.000Z',
    '2031-02-03T04:05:06Z',
    '2031-02-03T04:05:06.789+00:00',
    1_927_771_506_789,
    null,
  ];
  expect(values.map(occurredAt)).toStrictEqual(values.map(() => false));
});

import { accountingDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

// 留出两端一年余量；包含纪元之前、世纪闰年和四位年份范围。
const instant = fc.integer({
  min: Date.parse('0002-01-01T00:00:00Z'),
  max: Date.parse('9998-12-31T23:59:59.999Z'),
});

it('[AC-B1-08d#13] 属性：任意时刻落在其 +08:00 自然日 [start, end) 中', () => {
  const params = propParams();
  const stats = createPropStats('calendar:day-containment');
  fc.assert(
    fc.property(instant, (time) => {
      stats.hit(time < 0 ? 'before-epoch' : 'since-epoch');
      const at = new Date(time);
      const date = accountingDate(at);
      const { start, end } = chinaDayRange(date);
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        start === `${date}T00:00:00+08:00` &&
        /^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/.test(end) &&
        Date.parse(start) <= time &&
        time < Date.parse(end) &&
        Date.parse(end) - Date.parse(start) === 86_400_000 &&
        accountingDate(new Date(start)) === date &&
        accountingDate(new Date(Date.parse(end) - 1)) === date &&
        accountingDate(new Date(end)) !== date &&
        chinaDayRange(accountingDate(new Date(end))).start === end &&
        at.getTime() === time
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-08d#14] 属性：任意时刻落在其 +08:00 自然月 [start, end) 中', () => {
  const params = propParams();
  const stats = createPropStats('calendar:month-containment');
  fc.assert(
    fc.property(instant, (time) => {
      stats.hit(time < 0 ? 'before-epoch' : 'since-epoch');
      const at = new Date(time);
      const month = chinaMonth(at);
      const { start, end } = chinaMonthRange(month);
      const length = (Date.parse(end) - Date.parse(start)) / 86_400_000;
      return (
        /^\d{4}-\d{2}$/.test(month) &&
        start === `${month}-01T00:00:00+08:00` &&
        /^\d{4}-\d{2}-01T00:00:00\+08:00$/.test(end) &&
        Date.parse(start) <= time &&
        time < Date.parse(end) &&
        [28, 29, 30, 31].includes(length) &&
        accountingDate(at).startsWith(`${month}-`) &&
        accountingDate(new Date(start)) === `${month}-01` &&
        chinaMonth(new Date(Date.parse(end) - 1)) === month &&
        chinaMonth(new Date(end)) !== month &&
        chinaMonthRange(chinaMonth(new Date(end))).start === end &&
        at.getTime() === time
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

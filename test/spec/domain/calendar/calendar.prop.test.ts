import { chinaDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
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
      const date = chinaDate(at);
      const { start, end } = chinaDayRange(date);
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        start.getTime() <= time &&
        time < end.getTime() &&
        end.getTime() - start.getTime() === 86_400_000 &&
        chinaDate(start) === date &&
        chinaDate(new Date(end.getTime() - 1)) === date &&
        chinaDate(end) !== date &&
        chinaDayRange(chinaDate(end)).start.getTime() === end.getTime() &&
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
      const length = (end.getTime() - start.getTime()) / 86_400_000;
      return (
        /^\d{4}-\d{2}$/.test(month) &&
        start.getTime() <= time &&
        time < end.getTime() &&
        [28, 29, 30, 31].includes(length) &&
        chinaDate(at).startsWith(`${month}-`) &&
        chinaDate(start) === `${month}-01` &&
        chinaMonth(new Date(end.getTime() - 1)) === month &&
        chinaMonth(end) !== month &&
        chinaMonthRange(chinaMonth(end)).start.getTime() === end.getTime() &&
        at.getTime() === time
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

// B2-04zg: the period the catch-up looks back at (D10-476; 08 BR-FUND-04 ③: the bill of month M =
// the previous natural month is generated on settle.bill_day, 22–28, +08:00). D* is the latest
// bill day on or before the given +08:00 day (the bill day itself included), M the month before
// D*'s month; nothing earlier is ever returned. Unit test, no database. Top-level it() only.
import { expect, it } from 'vitest';
import { settleBillCatchUpPeriod } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import { refusal } from '../worker/kit.ts';

it('[AC-B2-04zg#1] 回看期次：D* = 不晚于当天（+08:00）的最近一个账单日（账单日当天即当天），M = D* 的上一自然月；跨年、闰年 2 月、账单日 22 与 28 照样；非法日期或账单日不在 22–28 被拒绝', async () => {
  const cases: [string, number, string, string][] = [
    // The bill day itself, the day after it, the last day before the next one.
    ['2032-07-24', 24, '2032-07-24', '2032-06'],
    ['2032-07-25', 24, '2032-07-24', '2032-06'],
    ['2032-08-23', 24, '2032-07-24', '2032-06'],
    // The day before the bill day looks back at the previous month's bill day.
    ['2032-07-23', 24, '2032-06-24', '2032-05'],
    ['2032-07-01', 24, '2032-06-24', '2032-05'],
    // Across the year.
    ['2033-01-10', 24, '2032-12-24', '2032-11'],
    ['2033-01-24', 24, '2033-01-24', '2032-12'],
    ['2032-12-31', 24, '2032-12-24', '2032-11'],
    // Bill day 28 in a leap February, and the days after it.
    ['2032-02-28', 28, '2032-02-28', '2032-01'],
    ['2032-02-29', 28, '2032-02-28', '2032-01'],
    ['2032-03-27', 28, '2032-02-28', '2032-01'],
    ['2032-03-28', 28, '2032-03-28', '2032-02'],
    // Bill day 22.
    ['2032-03-21', 22, '2032-02-22', '2032-01'],
    ['2032-03-22', 22, '2032-03-22', '2032-02'],
  ];
  expect(
    cases.map(([today, billDay]) => {
      const period = settleBillCatchUpPeriod(today, billDay);
      return [today, billDay, period.accountingDate, period.billId];
    }),
  ).toStrictEqual(cases);

  for (const billDay of [21, 29, 0, 24.5, Number.NaN]) {
    await refusal(async () => settleBillCatchUpPeriod('2032-07-25', billDay));
  }
  for (const today of ['2032-02-30', '2031-02-29', '2032-7-25', '2032/07/25', '']) {
    await refusal(async () => settleBillCatchUpPeriod(today, 24));
  }
});

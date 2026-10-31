// B2-08b (规划/08 BR-WDR-20: 计税年度取提现单 created_at 的 +08:00 自然年; task §9.2 1: accountingDate's
// year, never getFullYear): taxYearOf(createdAt). Pure, no database. Boundaries at 00:00 +08:00 on
// 1 January, where the UTC year (and a host clock in another zone) still says the year before.
// Top-level it() only (规划/11 §4.3); the property's runs and seed come from PROP_RUNS / PROP_SEED
// (@couli/testing), its body returns a boolean and the one assertion is outside fc.check.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { taxYearOf } from '../../../../apps/api/src/modules/payout/application/tax-ytd.ts';

const EIGHT_HOURS = 8 * 3_600_000;
/** The timeout grows with the runs (as test/spec/payout/entry/mode.test.ts). */
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it('[AC-B2-08b#year] 年度取 +08:00 自然年：12-31 23:30 +08:00 → 当年；次年 01-01 00:30 +08:00（UTC 仍是前一年）→ 次年；00:00 +08:00 前后一毫秒分属两年', () => {
  expect(taxYearOf(new Date('2026-12-31T23:30:00+08:00'))).toBe(2026);
  expect(taxYearOf(new Date('2027-01-01T00:30:00+08:00'))).toBe(2027);
  expect(new Date('2027-01-01T00:30:00+08:00').getUTCFullYear()).toBe(2026);
  expect(taxYearOf(new Date('2026-12-31T15:59:59.999Z'))).toBe(2026);
  expect(taxYearOf(new Date('2026-12-31T16:00:00.000Z'))).toBe(2027);
  expect(taxYearOf(new Date('2026-10-19T09:58:00+08:00'))).toBe(2026);
});

/** The year expected for `at`: the UTC year of `at` + 8 hours. */
function expectedYear(at: Date): number {
  return new Date(at.getTime() + EIGHT_HOURS).getUTCFullYear();
}

/** Whether taxYearOf gives the +08:00 year of `at` and leaves `at` as it was. */
function holds(at: Date): boolean {
  const ms = at.getTime();
  const year = taxYearOf(at);
  return year === expectedYear(at) && at.getTime() === ms;
}

/** The first instant where the rule does not hold (what taxYearOf gave); null when every run holds. */
function firstViolation(): unknown {
  const min = new Date('2026-01-01T00:00:00+08:00');
  const max = new Date(Date.parse('2100-01-01T00:00:00+08:00') - 1);
  const details = fc.check(
    fc.property(fc.date({ min, max, noInvalidDate: true }), (at) => holds(at)),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  if (example === null) return { error: String(details.errorInstance) };
  const [at] = example;
  const ms = at.getTime();
  const year = taxYearOf(at);
  return {
    at: new Date(ms).toISOString(),
    expected: expectedYear(at),
    year,
    unchanged: at.getTime() === ms,
  };
}

it(
  '[AC-B2-08b#year] 任意时刻（2026–2099）：年度 = 该时刻 +8 小时后的 UTC 年份；不改传入的 Date',
  () => {
    expect(firstViolation()).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

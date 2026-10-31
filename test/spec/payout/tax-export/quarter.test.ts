// B2-08d (规划/08 BR-WDR-21: 按自然季度（+08:00，按 paid_at）导出; 例：Q4 = [2026-10-01T00:00+08:00,
// 2027-01-01T00:00+08:00); task §9.1 / §9.2 1): the quarter of the tax export. Pure, no database.
// taxExportQuarterRange(quarter) gives [start, end) as chinaMonthRange's strings (first month's
// start, last month's end); a quarter that is not ^\d{4}-Q[1-4]$ with year 2026..2100 is refused
// with TaxExportBadQuarter — by the range and by the reader, before it touches the database.
// Top-level it() only (规划/11 §4.3); the property's runs and seed come from PROP_RUNS / PROP_SEED
// (@couli/testing), its body returns a boolean and the one assertion is outside fc.check.
import type { DB } from '@couli/db';
import { chinaMonthRange } from '@couli/domain';
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { taxExportQuarterRange } from '../../../../apps/api/src/modules/payout/application/tax-export-read.ts';
// The reader and its refusals through the module's only public exit.
import {
  createTaxExportReader,
  TaxExportBadQuarter,
} from '../../../../apps/api/src/modules/payout/index.ts';
import { fakeDecrypt } from './kit.ts';

const EIGHT_HOURS = 8 * 3_600_000;
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

const BAD_QUARTERS = [
  '2025-Q4',
  '2101-Q1',
  '0000-Q1',
  '2026-Q0',
  '2026-Q5',
  '2026-q1',
  '2026Q1',
  '2026-Q01',
  '26-Q1',
  '2026-1',
  '2026-01',
  ' 2026-Q1',
  '2026-Q1 ',
  '2026-Q1\n',
  '２０２６-Q1',
  '',
] as const;

it('[AC-B2-08d#quarter] 季度区间：首月 1 日 00:00 +08:00 起、次季度首月 1 日 00:00 +08:00 止（左闭右开），Q4 跨年', () => {
  expect(taxExportQuarterRange('2026-Q4')).toEqual({
    start: '2026-10-01T00:00:00+08:00',
    end: '2027-01-01T00:00:00+08:00',
  });
  expect(taxExportQuarterRange('2027-Q1')).toEqual({
    start: '2027-01-01T00:00:00+08:00',
    end: '2027-04-01T00:00:00+08:00',
  });
  expect(taxExportQuarterRange('2027-Q2')).toEqual({
    start: '2027-04-01T00:00:00+08:00',
    end: '2027-07-01T00:00:00+08:00',
  });
  expect(taxExportQuarterRange('2027-Q3')).toEqual({
    start: '2027-07-01T00:00:00+08:00',
    end: '2027-10-01T00:00:00+08:00',
  });
  // The ends of the accepted years.
  expect(taxExportQuarterRange('2026-Q1')).toEqual({
    start: '2026-01-01T00:00:00+08:00',
    end: '2026-04-01T00:00:00+08:00',
  });
  expect(taxExportQuarterRange('2100-Q4')).toEqual({
    start: '2100-10-01T00:00:00+08:00',
    end: '2101-01-01T00:00:00+08:00',
  });
  // Instants: the Q4 start is 16:00 UTC the day before.
  const q4 = taxExportQuarterRange('2026-Q4');
  expect(Date.parse(q4.start)).toBe(Date.parse('2026-09-30T16:00:00.000Z'));
  expect(Date.parse(q4.end)).toBe(Date.parse('2026-12-31T16:00:00.000Z'));
});

it.each(BAD_QUARTERS)(
  '[AC-B2-08d#quarter] 非法季度 %j → TaxExportBadQuarter（格式 YYYY-Qn、年 2026..2100）',
  (quarter) => {
    let thrown: unknown = null;
    try {
      taxExportQuarterRange(quarter);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaxExportBadQuarter);
  },
);

/** A handle that fails the test if the reader touches it. */
function untouchable(): Kysely<DB> {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`the reader touched the database (${String(key)}) for a bad quarter`);
      },
    },
  ) as Kysely<DB>;
}

it.each(BAD_QUARTERS)(
  '[AC-B2-08d#quarter] 读端口拿到非法季度 %j → TaxExportBadQuarter，不碰数据库、不解密',
  async (quarter) => {
    const port = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: port.decrypt });
    let thrown: unknown = null;
    try {
      await read(untouchable(), { appId: 'tx_synthetic', quarter });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaxExportBadQuarter);
    expect(port.calls).toEqual([]);
  },
);

/** The quarter string of an instant: its +08:00 year and month (UTC fields after + 8 hours). */
function quarterOf(at: number): string {
  const shifted = new Date(at + EIGHT_HOURS);
  const month = shifted.getUTCMonth();
  return `${shifted.getUTCFullYear()}-Q${Math.floor(month / 3) + 1}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Whether the quarter of `at` contains it, is built from chinaMonthRange and abuts its neighbours. */
function holds(at: number): boolean {
  const quarter = quarterOf(at);
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(6));
  const range = taxExportQuarterRange(quarter);
  const first = chinaMonthRange(`${year}-${pad2(q * 3 - 2)}`);
  const last = chinaMonthRange(`${year}-${pad2(q * 3)}`);
  const contains = Date.parse(range.start) <= at && at < Date.parse(range.end);
  const built = range.start === first.start && range.end === last.end;
  // The instant just before the start belongs to the previous quarter, the end to the next.
  const before = Date.parse(range.start) - 1;
  const previousOk = year === 2026 && q === 1 ? true : quarterOf(before) !== quarter;
  const nextOk = quarterOf(Date.parse(range.end)) !== quarter;
  return contains && built && previousOk && nextOk;
}

/** The first instant where the rule does not hold; null when every run holds. */
function firstViolation(): unknown {
  const min = new Date('2026-01-01T00:00:00+08:00');
  const max = new Date(Date.parse('2101-01-01T00:00:00+08:00') - 1);
  const instants = fc.date({ min, max, noInvalidDate: true }).map((at) => at.getTime());
  const details = fc.check(
    fc.property(instants, (at) => holds(at)),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  if (example === null) return { error: String(details.errorInstance) };
  const [at] = example;
  let range: unknown;
  try {
    range = taxExportQuarterRange(quarterOf(at));
  } catch (error) {
    range = { error: String(error) };
  }
  return { at: new Date(at).toISOString(), quarter: quarterOf(at), range };
}

it(
  '[AC-B2-08d#quarter] 任意时刻（2026–2100 年）落在其 +08:00 年月所属季度的区间内；区间 = 首月 chinaMonthRange 的 start 到末月的 end',
  () => {
    // Called once outside the property so a skeleton fails on its own NotImplemented.
    expect(taxExportQuarterRange('2026-Q2').start).toBe('2026-04-01T00:00:00+08:00');
    expect(firstViolation()).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

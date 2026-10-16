// B1-17b: the run decision of price_snapshot (BR-WATCH-05 (2); BR-WATCH-19 细则例; orchestrator
// semantics B.1). Pure function, no database.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  decidePriceRun,
  type PriceSnapshotRun,
  type PriceSnapshotValues,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { MINUTE, at, vals } from './kit.ts';

interface Row {
  values: PriceSnapshotValues;
  first: number;
  last: number;
  count: number;
}

/** Applies decidePriceRun to a sequence of one key, the way the store does; returns the rows. */
function drive(
  sequence: readonly { values: PriceSnapshotValues; t: number }[],
  intervalMinutes: number,
): { rows: Row[]; counted: number[] } {
  const rows: Row[] = [];
  const counted: number[] = [];
  for (const o of sequence) {
    const latest = rows[rows.length - 1];
    const latestRun: PriceSnapshotRun | null =
      latest === undefined
        ? null
        : Object.freeze({
            ...latest.values,
            firstObservedAt: new Date(latest.first),
            lastObservedAt: new Date(latest.last),
            observationCount: latest.count,
          });
    const decision = decidePriceRun(
      latestRun,
      Object.freeze({ values: Object.freeze({ ...o.values }), observedAt: new Date(o.t) }),
      intervalMinutes,
    );
    if (decision.kind === 'insert') {
      rows.push({ values: { ...o.values }, first: o.t, last: o.t, count: 1 });
      counted.push(1);
    } else if (decision.kind === 'touch') {
      expect(latest).toBeDefined();
      expect(decision.lastObservedAt.getTime()).toBeGreaterThanOrEqual(latest!.last);
      latest!.last = decision.lastObservedAt.getTime();
      latest!.count = decision.observationCount;
      counted[counted.length - 1] = (counted[counted.length - 1] ?? 0) + 1;
    } else {
      expect(decision).toEqual({ kind: 'none' });
    }
  }
  return { rows, counted };
}

function same(a: PriceSnapshotValues, b: PriceSnapshotValues): boolean {
  return (
    a.priceFen === b.priceFen &&
    a.couponFen === b.couponFen &&
    a.finalPriceFen === b.finalPriceFen &&
    a.inStock === b.inStock
  );
}

/** Independent model of BR-WATCH-05 (2) with orchestrator rule B.1 (out of order → nothing). */
function model(
  sequence: readonly { values: PriceSnapshotValues; t: number }[],
  intervalMinutes: number,
): Row[] {
  const rows: Row[] = [];
  for (const o of sequence) {
    const latest = rows[rows.length - 1];
    if (latest !== undefined && o.t < latest.last) continue;
    if (latest === undefined || !same(latest.values, o.values)) {
      rows.push({ values: { ...o.values }, first: o.t, last: o.t, count: 1 });
    } else if (o.t - latest.last >= intervalMinutes * MINUTE) {
      latest.last = o.t;
      latest.count += 1;
    }
  }
  return rows;
}

function run(
  values: PriceSnapshotValues,
  first: Date,
  last: Date,
  count: number,
): PriceSnapshotRun {
  return { ...values, firstObservedAt: first, lastObservedAt: last, observationCount: count };
}

it('[AC-B1-17b#1] BR-WATCH-05 细则例（watch）：4500×2、超时不交、3900×3 → 两行 (4500, 08:00, 14:00, 2)、(3900, 20:00, 20:15, 2)', () => {
  // 17:00 timed out: a failed query never reaches the run decision (writable.test.ts covers it).
  const sequence = [
    { values: vals(4500n), t: at('08:00').getTime() },
    { values: vals(4500n), t: at('14:00').getTime() },
    { values: vals(3900n), t: at('20:00').getTime() },
    { values: vals(3900n), t: at('20:05').getTime() },
    { values: vals(3900n), t: at('20:15').getTime() },
  ];
  expect(drive(sequence, 10).rows).toEqual([
    { values: vals(4500n), first: at('08:00').getTime(), last: at('14:00').getTime(), count: 2 },
    { values: vals(3900n), first: at('20:00').getTime(), last: at('20:15').getTime(), count: 2 },
  ]);
}, 10_000);

it('[AC-B1-17b#2] BR-WATCH-19 细则例（detail）：09-30 4500、10-01 4500、10-02 3900 → (4500, 09-30, 10-01, 2)、(3900, 10-02, 10-02, 1)', () => {
  const d1 = at('10:00', '2031-09-30').getTime();
  const d2 = at('10:00', '2031-10-01').getTime();
  const d3 = at('10:00', '2031-10-02').getTime();
  const sequence = [
    { values: vals(4500n), t: d1 },
    { values: vals(4500n), t: d2 },
    { values: vals(3900n), t: d3 },
  ];
  expect(drive(sequence, 10).rows).toEqual([
    { values: vals(4500n), first: d1, last: d2, count: 2 },
    { values: vals(3900n), first: d3, last: d3, count: 1 },
  ]);
}, 10_000);

it('[AC-B1-17b#3] 无最新行 → 插入新行', () => {
  expect(decidePriceRun(null, { values: vals(4500n), observedAt: at('08:00') }, 10)).toEqual({
    kind: 'insert',
  });
}, 10_000);

it.each([
  ['price_fen', vals(4500n, { priceFen: 4600n })],
  ['coupon_fen', vals(4500n, { couponFen: 100n })],
  ['final_price_fen', vals(4500n, { finalPriceFen: 4400n })],
  ['in_stock', vals(4500n, { inStock: false })],
] as const)(
  '[AC-B1-17b#4] 四值中只有 %s 不同 → 插入新行（间隔不足 1 分钟也插入）',
  (_field, changed) => {
    const latest = run(vals(4500n), at('08:00'), at('08:00'), 1);
    expect(decidePriceRun(latest, { values: changed, observedAt: at('08:00') }, 10)).toEqual({
      kind: 'insert',
    });
    expect(
      decidePriceRun(
        latest,
        { values: changed, observedAt: new Date(at('08:00').getTime() + 1) },
        10,
      ),
    ).toEqual({ kind: 'insert' });
  },
  10_000,
);

it('[AC-B1-17b#5] 四值相同、距上次触达恰好 10 分钟 → 前移 last_observed_at 且 count + 1', () => {
  const latest = run(vals(3900n), at('20:00'), at('20:00'), 4);
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('20:10') }, 10)).toEqual({
    kind: 'touch',
    lastObservedAt: at('20:10'),
    observationCount: 5,
  });
}, 10_000);

it('[AC-B1-17b#6] 四值相同、距上次触达差 1 毫秒不足 10 分钟 → 两者都不更新', () => {
  const latest = run(vals(3900n), at('19:00'), at('20:00'), 2);
  const almost = new Date(at('20:10').getTime() - 1);
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: almost }, 10)).toEqual({
    kind: 'none',
  });
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('20:00') }, 10)).toEqual({
    kind: 'none',
  });
}, 10_000);

it('[AC-B1-17b#7] 间隔取配置值而非固定 10：30 分钟时 20 分钟不动、30 分钟前移；1 分钟时 1 分钟即前移', () => {
  const latest = run(vals(3900n), at('20:00'), at('20:00'), 1);
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('20:20') }, 30)).toEqual({
    kind: 'none',
  });
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('20:30') }, 30)).toEqual({
    kind: 'touch',
    lastObservedAt: at('20:30'),
    observationCount: 2,
  });
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('20:01') }, 1)).toEqual({
    kind: 'touch',
    lastObservedAt: at('20:01'),
    observationCount: 2,
  });
}, 10_000);

it('[AC-B1-17b#8] 乱序：观测时刻早于最新行 last_observed_at → 不动不插（四值不同也不插）', () => {
  const latest = run(vals(3900n), at('20:00'), at('20:15'), 2);
  expect(decidePriceRun(latest, { values: vals(4500n), observedAt: at('20:14') }, 10)).toEqual({
    kind: 'none',
  });
  expect(decidePriceRun(latest, { values: vals(3900n), observedAt: at('08:00') }, 10)).toEqual({
    kind: 'none',
  });
}, 10_000);

it('[AC-B1-17b#9] 判定不修改传入的最新行与观测（冻结输入下照常返回）', () => {
  const latest = Object.freeze(run(vals(3900n), at('20:00'), at('20:00'), 1));
  const observed = Object.freeze({ values: Object.freeze(vals(3900n)), observedAt: at('20:30') });
  expect(decidePriceRun(latest, observed, 10)).toEqual({
    kind: 'touch',
    lastObservedAt: at('20:30'),
    observationCount: 2,
  });
  expect(latest.lastObservedAt).toEqual(at('20:00'));
  expect(latest.observationCount).toBe(1);
}, 10_000);

/** Amounts that collide when truncated to 32 bits (2^32 + 1 vs 1, 2^31 + 1 vs -2^31 + 1) or
 * rounded to a double (2^53 + 1 vs 2^53), plus 0, 1 and odd values. */
const TRUNC_1 = 4_294_967_297n; // 2^32 + 1, low 32 bits = 1
const OVER_INT32 = 2_147_483_649n; // 2^31 + 1
const DOUBLE_EDGE = 9_007_199_254_740_992n; // 2^53
const boundaryValuesArb = fc.constantFrom(
  vals(4500n),
  vals(3900n),
  vals(4500n, { couponFen: 500n, finalPriceFen: 4000n }),
  vals(4500n, { inStock: false }),
  vals(1n),
  vals(TRUNC_1),
  vals(OVER_INT32),
  vals(OVER_INT32, { couponFen: 1n, finalPriceFen: OVER_INT32 - 1n }),
  vals(OVER_INT32 + 2n, { couponFen: 3n, finalPriceFen: OVER_INT32 - 1n }),
  vals(DOUBLE_EDGE),
  vals(DOUBLE_EDGE + 1n),
  vals(4501n, { couponFen: 0n, finalPriceFen: 4501n }),
  vals(4501n, { couponFen: 1n, finalPriceFen: 4500n }),
  vals(4501n, { couponFen: TRUNC_1, finalPriceFen: 4500n }),
  vals(4501n, { couponFen: 1n, finalPriceFen: TRUNC_1 }),
  vals(0n),
);
const randomValuesArb = fc
  .record({
    price: fc.oneof(fc.bigInt({ min: 0n, max: 9n }), fc.bigInt({ min: 0n, max: 2n ** 62n })),
    coupon: fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 2n ** 40n })),
    final: fc.oneof(fc.constant(1n), fc.bigInt({ min: 0n, max: 2n ** 62n })),
    inStock: fc.boolean(),
  })
  .map((r): PriceSnapshotValues => ({
    priceFen: r.price,
    couponFen: r.coupon,
    finalPriceFen: r.final,
    inStock: r.inStock,
  }));
const valuesArb = fc.oneof(
  { arbitrary: boundaryValuesArb, weight: 4 },
  { arbitrary: randomValuesArb, weight: 1 },
);
it.each([
  ['price_fen 1 → 2^31 + 1', vals(1n), vals(OVER_INT32)],
  ['price_fen 1 → 2^32 + 1（低 32 位相同）', vals(1n), vals(TRUNC_1)],
  ['price_fen 2^53 → 2^53 + 1（转双精度相同）', vals(DOUBLE_EDGE), vals(DOUBLE_EDGE + 1n)],
  [
    'coupon_fen 1 → 2^32 + 1',
    vals(4501n, { couponFen: 1n, finalPriceFen: 4500n }),
    vals(4501n, { couponFen: TRUNC_1, finalPriceFen: 4500n }),
  ],
  [
    'final_price_fen 1 → 2^32 + 1',
    vals(4501n, { couponFen: 1n, finalPriceFen: 1n }),
    vals(4501n, { couponFen: 1n, finalPriceFen: TRUNC_1 }),
  ],
  ['price_fen 0 → 1', vals(0n), vals(1n)],
  ['price_fen 4501 → 4500（奇偶差 1）', vals(4501n), vals(4500n)],
] as const)(
  '[AC-B1-17b#45] 金额按整数分精确比较（不截断为 32 位、不转双精度）：%s → 插入新行',
  (_name, before, after) => {
    const latest = run(before, at('08:00'), at('08:00'), 3);
    expect(decidePriceRun(latest, { values: after, observedAt: at('08:30') }, 10)).toEqual({
      kind: 'insert',
    });
    expect(decidePriceRun(latest, { values: { ...before }, observedAt: at('08:30') }, 10)).toEqual({
      kind: 'touch',
      lastObservedAt: at('08:30'),
      observationCount: 4,
    });
  },
  10_000,
);

const stepArb = fc.integer({ min: -20 * MINUTE, max: 40 * MINUTE });
const sequenceArb = fc
  .array(fc.record({ values: valuesArb, step: stepArb }), { minLength: 1, maxLength: 40 })
  .map((items) => {
    let t = at('00:00').getTime();
    return items.map(({ values, step }) => {
      t += step;
      return { values, t };
    });
  });

it('[AC-B1-17b#10] 属性：任意观测序列下与独立模型一致；相邻两行四值必不同；observation_count = 该行计入的观测数；last_observed_at 单调不减', () => {
  let checked = 0;
  fc.assert(
    fc.property(sequenceArb, fc.integer({ min: 1, max: 60 }), (sequence, interval) => {
      const { rows, counted } = drive(sequence, interval);
      expect(rows).toEqual(model(sequence, interval));
      for (let i = 1; i < rows.length; i += 1) {
        expect(same(rows[i - 1]!.values, rows[i]!.values)).toBe(false);
        expect(rows[i]!.first).toBeGreaterThanOrEqual(rows[i - 1]!.last);
      }
      rows.forEach((row, i) => {
        expect(row.count).toBe(counted[i]);
        expect(row.last).toBeGreaterThanOrEqual(row.first);
      });
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);

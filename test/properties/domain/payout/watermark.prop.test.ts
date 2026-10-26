// B2-06c the pure watermark functions (规划/08 BR-WDR-18, BR-WDR-12 ③). The reference model below
// is written from the rule text, never from the implementation:
//   window  [today 00:00 +08:00 − 7 days, today 00:00 +08:00);
//   P       round_half_up(total / 7) × 3;
//   verdict stale (no reading, or now − t_W > 2 h) → below forecast (W < P) →
//           usable exceeded (Σ × 10000 > W × bp, i.e. Σ > W × bp / 10000 exactly, no rounding) → ok.
// Properties follow test/properties/README.md: the property body returns a boolean, one summary
// assertion after fc.assert, generator statistics through createPropStats (amount tiers 0, 1, odd,
// > 2^31 each hit in at least 1% of the runs).
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  forecastFen,
  forecastWindow,
  judgeWatermark,
  type WatermarkCheckInput,
  type WatermarkVerdict,
} from '../../../../apps/api/src/modules/payout/domain/watermark.ts';

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const TWO_HOURS = 7_200_000;
const TWO_31 = 2n ** 31n;
const TIERS = ['zero', 'one', 'odd', 'above-2^31'] as const;
const NOW = new Date('2026-10-19T02:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() - ms);

function modelWindow(nowMs: number) {
  const to = Math.floor((nowMs + OFFSET) / DAY) * DAY - OFFSET;
  return { from: to - 7 * DAY, to };
}

function modelForecast(total: bigint): bigint {
  // round_half_up for a non-negative total: floor((2 × total + 7) / 14).
  return ((2n * total + 7n) / 14n) * 3n;
}

function model(input: WatermarkCheckInput): WatermarkVerdict {
  if (
    input.reading === null ||
    input.now.getTime() - input.reading.measuredAt.getTime() > TWO_HOURS
  ) {
    return { ok: false, reason: 'watermark_stale' };
  }
  const w = input.reading.availableFen;
  if (w < input.forecastFen) return { ok: false, reason: 'watermark_below_forecast' };
  const sum = input.batchNetFen + input.payingNetFen + input.paidSinceNetFen;
  if (sum * 10000n > w * BigInt(input.usableBp)) {
    return { ok: false, reason: 'watermark_usable_exceeded' };
  }
  return { ok: true };
}

function sameVerdict(actual: WatermarkVerdict, expected: WatermarkVerdict): boolean {
  if (expected.ok) return actual.ok;
  return !actual.ok && actual.reason === expected.reason;
}

/** Amount tiers of README: 0, 1, odd, > 2^31 (a value may fall into several). */
function tiersOf(fen: bigint): string[] {
  const hit: string[] = [];
  if (fen === 0n) hit.push('zero');
  if (fen === 1n) hit.push('one');
  if (fen % 2n === 1n) hit.push('odd');
  if (fen > TWO_31) hit.push('above-2^31');
  return hit;
}

/** The one summary of a property: runs, discards, and the tiers hit in fewer than 1% of runs. */
function summary(record: PropStatsRecord, tiers: readonly string[]) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: tiers.filter((tier) => (record.hits[tier] ?? 0) * 100 < runs),
  };
}

const fen = fc.oneof(
  fc.constantFrom(0n, 1n),
  fc.bigInt({ min: 0n, max: 10n ** 6n }).map((v) => 2n * v + 1n),
  fc.bigInt({ min: TWO_31 + 1n, max: 10n ** 15n }),
  fc.bigInt({ min: 0n, max: 10n ** 12n }),
);

const instant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) });

it('[AC-B2-06c#3] forecastWindow 例：近 7 个完整自然日（+08:00，不含当日），00:00 +08:00 属于新的一天', () => {
  expect(forecastWindow(new Date('2026-10-19T02:00:00.000Z'))).toEqual({
    from: new Date('2026-10-11T16:00:00.000Z'),
    to: new Date('2026-10-18T16:00:00.000Z'),
  });
  expect(forecastWindow(new Date('2026-10-18T16:00:00.000Z')).to).toEqual(
    new Date('2026-10-18T16:00:00.000Z'),
  );
  expect(forecastWindow(new Date('2026-10-18T15:59:59.999Z')).to).toEqual(
    new Date('2026-10-17T16:00:00.000Z'),
  );
});

it('[AC-B2-06c#3] forecastFen 例：P = round_half_up(合计 / 7) × 3', () => {
  // 规划/08 BR-WDR-18 例：近 7 日申请合计 ¥49,000 → 日均 ¥7,000 → P = ¥21,000.
  expect(forecastFen(4_900_000n)).toBe(2_100_000n);
  // 7004 / 7 = 1000.57… → 1001 → 3003 (not 3002 = round(7004 × 3 / 7), not 3000 = floor).
  expect(forecastFen(7004n)).toBe(3003n);
  expect(forecastFen(7003n)).toBe(3000n);
  expect(forecastFen(0n)).toBe(0n);
});

it('[AC-B2-06c#3] judgeWatermark 例：规则示例、2 小时边界恰好等于通过、可用上限精确比较不取整', () => {
  const base = {
    now: NOW,
    forecastFen: 2_100_000n,
    batchNetFen: 2_700_000n,
    payingNetFen: 800_000n,
    paidSinceNetFen: 200_000n,
    usableBp: 9000,
  };
  const fresh = (availableFen: bigint) => ({ availableFen, measuredAt: at(60_000) });
  // 例：W=¥40,000，P=¥21,000，PAYING ¥8,000，t_W 后到账 ¥2,000，本批 ¥27,000 → 37,000 > 36,000.
  expect(judgeWatermark({ ...base, reading: fresh(4_000_000n) })).toEqual({
    ok: false,
    reason: 'watermark_usable_exceeded',
  });
  expect(judgeWatermark({ ...base, batchNetFen: 2_600_000n, reading: fresh(4_000_000n) })).toEqual({
    ok: true,
  });
  // 例：W=¥20,000 < P → 拒绝。
  expect(judgeWatermark({ ...base, reading: fresh(2_000_000n) })).toEqual({
    ok: false,
    reason: 'watermark_below_forecast',
  });
  // 例：09:00 取数，11:30 执行 → 2.5 小时，过期（即使 W 也不足，先报过期）。
  expect(
    judgeWatermark({
      ...base,
      reading: { availableFen: 2_000_000n, measuredAt: at(2.5 * 3_600_000) },
    }),
  ).toEqual({ ok: false, reason: 'watermark_stale' });
  expect(judgeWatermark({ ...base, reading: null })).toEqual({
    ok: false,
    reason: 'watermark_stale',
  });
  expect(
    judgeWatermark({
      ...base,
      batchNetFen: 2_600_000n,
      reading: { availableFen: 4_000_000n, measuredAt: at(TWO_HOURS) },
    }),
  ).toEqual({ ok: true });
  // Exact: 1 × 9000 / 10000 = 0.9 and 10001 × 9000 / 10000 = 9000.9 (round_half_up would pass both).
  const exact = {
    now: NOW,
    forecastFen: 0n,
    payingNetFen: 0n,
    paidSinceNetFen: 0n,
    usableBp: 9000,
  };
  expect(judgeWatermark({ ...exact, batchNetFen: 1n, reading: fresh(1n) })).toEqual({
    ok: false,
    reason: 'watermark_usable_exceeded',
  });
  expect(judgeWatermark({ ...exact, batchNetFen: 9001n, reading: fresh(10001n) })).toEqual({
    ok: false,
    reason: 'watermark_usable_exceeded',
  });
  expect(judgeWatermark({ ...exact, batchNetFen: 9000n, reading: fresh(10001n) })).toEqual({
    ok: true,
  });
});

it('[AC-B2-06c#7] forecastWindow 属性：任意时刻都是近 7 个完整自然日（+08:00，不含当日）', () => {
  const params = propParams();
  const stats = createPropStats('B2-06c:forecast-window');
  const nowMs = fc.oneof(
    instant,
    instant.map((ms) => modelWindow(ms).to),
    instant.map((ms) => modelWindow(ms).to - 1),
  );
  fc.assert(
    fc.property(nowMs, (ms) => {
      stats.hit('run');
      if ((ms + OFFSET) % DAY === 0) stats.hit('midnight');
      const window = forecastWindow(new Date(ms));
      const expected = modelWindow(ms);
      return (
        window.from.getTime() === expected.from &&
        window.to.getTime() === expected.to &&
        window.to.getTime() <= ms &&
        ms - window.to.getTime() < DAY
      );
    }),
    params,
  );
  expect(summary(stats.flush(), ['midnight'])).toEqual({
    runs: params.numRuns,
    discards: 0,
    thin: [],
  });
}, 120_000);

it('[AC-B2-06c#7] forecastFen 属性：P = round_half_up(合计 / 7) × 3（bigint，不经浮点）', () => {
  const params = propParams();
  const stats = createPropStats('B2-06c:forecast-fen');
  fc.assert(
    fc.property(fen, (total) => {
      stats.hit('run');
      for (const tier of tiersOf(total)) stats.hit(tier);
      return forecastFen(total) === modelForecast(total);
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);

it('[AC-B2-06c#7] judgeWatermark 属性：与规则模型逐项一致（过期 → 低于 P → 超可用上限 → 通过）', () => {
  const params = propParams();
  const stats = createPropStats('B2-06c:judge-watermark');
  const input: fc.Arbitrary<WatermarkCheckInput> = fc.record({
    now: fc.constant(NOW),
    reading: fc.option(
      fc.record({
        availableFen: fen,
        measuredAt: fc
          .oneof(
            fc.integer({ min: -10 * 60_000, max: 4 * 3_600_000 }),
            fc.constantFrom(0, TWO_HOURS - 1, TWO_HOURS, TWO_HOURS + 1),
          )
          .map(at),
      }),
      { nil: null },
    ),
    forecastFen: fen,
    batchNetFen: fen,
    payingNetFen: fen,
    paidSinceNetFen: fen,
    usableBp: fc.oneof(fc.integer({ min: 0, max: 10000 }), fc.constantFrom(0, 9000, 10000)),
  });
  fc.assert(
    fc.property(input, (value) => {
      stats.hit('run');
      for (const tier of tiersOf(value.batchNetFen)) stats.hit(tier);
      return sameVerdict(judgeWatermark(value), model(value));
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);

it('[AC-B2-06c#7] judgeWatermark 属性：Σ（本批 + PAYING + t_W 后已付）恰等于 ⌊W × bp / 10000⌋ 通过，多 1 分即拒绝', () => {
  const params = propParams();
  const stats = createPropStats('B2-06c:usable-boundary');
  fc.assert(
    fc.property(
      fen,
      fc.oneof(fc.integer({ min: 0, max: 10000 }), fc.constantFrom(0, 9000, 10000)),
      fen,
      fen,
      (w, bp, k1, k2) => {
        stats.hit('run');
        for (const tier of tiersOf(w)) stats.hit(tier);
        const usable = (w * BigInt(bp)) / 10000n;
        const paying = k1 < usable ? k1 : usable;
        const paid = k2 < usable - paying ? k2 : usable - paying;
        const common = {
          now: NOW,
          reading: { availableFen: w, measuredAt: at(60_000) },
          forecastFen: 0n,
          payingNetFen: paying,
          paidSinceNetFen: paid,
          usableBp: bp,
        };
        const atLimit = judgeWatermark({ ...common, batchNetFen: usable - paying - paid });
        const over = judgeWatermark({ ...common, batchNetFen: usable - paying - paid + 1n });
        return atLimit.ok && !over.ok && over.reason === 'watermark_usable_exceeded';
      },
    ),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);

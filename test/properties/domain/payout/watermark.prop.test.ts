// B2-06c ⑦ properties of the pure watermark functions (规划/08 BR-WDR-18, BR-WDR-12 ③). The
// reference model below is written from the rule text, never from the implementation:
//   window  [today 00:00 +08:00 − 7 days, today 00:00 +08:00);
//   P       round_half_up(total / 7) × 3;
//   verdict stale (no reading, or now − t_W > 2 h) → below forecast (W < P) →
//           usable exceeded (Σ × 10000 > W × bp, i.e. Σ > W × bp / 10000 exactly) → ok.
import { propParams } from '@couli/testing';
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

const instant = fc.integer({
  min: Date.UTC(2020, 0, 1),
  max: Date.UTC(2040, 0, 1),
});

it('[AC-B2-06c#7] forecastWindow：近 7 个完整自然日（+08:00，不含当日）', () => {
  expect(forecastWindow(new Date('2026-10-19T02:00:00.000Z'))).toEqual({
    from: new Date('2026-10-11T16:00:00.000Z'),
    to: new Date('2026-10-18T16:00:00.000Z'),
  });
  // 00:00 +08:00 itself belongs to the new day; one millisecond before still to the old one.
  expect(forecastWindow(new Date('2026-10-18T16:00:00.000Z')).to).toEqual(
    new Date('2026-10-18T16:00:00.000Z'),
  );
  expect(forecastWindow(new Date('2026-10-18T15:59:59.999Z')).to).toEqual(
    new Date('2026-10-17T16:00:00.000Z'),
  );
  fc.assert(
    fc.property(instant, (nowMs) => {
      const window = forecastWindow(new Date(nowMs));
      const expected = modelWindow(nowMs);
      expect(window.from.getTime()).toBe(expected.from);
      expect(window.to.getTime()).toBe(expected.to);
      expect(window.to.getTime()).toBeLessThanOrEqual(nowMs);
      expect(nowMs - window.to.getTime()).toBeLessThan(DAY);
    }),
    propParams(),
  );
});

it('[AC-B2-06c#7] forecastFen：P = round_half_up(合计 / 7) × 3', () => {
  // 规划/08 BR-WDR-18 例：近 7 日申请合计 ¥49,000 → 日均 ¥7,000 → P = ¥21,000.
  expect(forecastFen(4_900_000n)).toBe(2_100_000n);
  // 7004 / 7 = 1000.57… → 1001 → 3003 (not 3002 = round(7004 × 3 / 7), not 3000 = floor).
  expect(forecastFen(7004n)).toBe(3003n);
  expect(forecastFen(7003n)).toBe(3000n);
  expect(forecastFen(0n)).toBe(0n);
  fc.assert(
    fc.property(
      fc.oneof(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.constantFrom(3n, 4n, 10n, 11n)),
      (total) => {
        expect(forecastFen(total)).toBe(modelForecast(total));
      },
    ),
    propParams(),
  );
});

it('[AC-B2-06c#7] judgeWatermark：与规则模型逐项一致（2 小时与 usable 边界恰好等于通过）', () => {
  const now = new Date('2026-10-19T02:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() - ms);
  const base = {
    now,
    forecastFen: 2_100_000n,
    batchNetFen: 2_700_000n,
    payingNetFen: 800_000n,
    paidSinceNetFen: 200_000n,
    usableBp: 9000,
  };
  // 例：W=¥40,000，P=¥21,000，PAYING ¥8,000，t_W 后到账 ¥2,000，本批 ¥27,000 → 37,000 > 36,000.
  expect(
    judgeWatermark({ ...base, reading: { availableFen: 4_000_000n, measuredAt: at(60_000) } }),
  ).toEqual({ ok: false, reason: 'watermark_usable_exceeded' });
  expect(
    judgeWatermark({
      ...base,
      batchNetFen: 2_600_000n,
      reading: { availableFen: 4_000_000n, measuredAt: at(60_000) },
    }),
  ).toEqual({ ok: true });
  // 例：W=¥20,000 < P → 拒绝。
  expect(
    judgeWatermark({ ...base, reading: { availableFen: 2_000_000n, measuredAt: at(60_000) } }),
  ).toEqual({ ok: false, reason: 'watermark_below_forecast' });
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

  const fen = fc.oneof(
    fc.bigInt({ min: 0n, max: 10n ** 12n }),
    fc.constantFrom(0n, 1n, 9000n, 10000n),
  );
  const input: fc.Arbitrary<WatermarkCheckInput> = fc.record({
    now: fc.constant(now),
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
      expect(judgeWatermark(value)).toEqual(model(value));
    }),
    propParams(),
  );
  // Equality of Σ and W × bp / 10000 passes; one fen more is refused.
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 9n }),
      fc.integer({ min: 0, max: 10000 }),
      (units, bp) => {
        const w = units * 10000n;
        const usable = (w * BigInt(bp)) / 10000n;
        const reading = { availableFen: w, measuredAt: at(60_000) };
        const zero = { now, reading, forecastFen: 0n, payingNetFen: 0n, paidSinceNetFen: 0n };
        expect(judgeWatermark({ ...zero, batchNetFen: usable, usableBp: bp })).toEqual({ ok: true });
        expect(judgeWatermark({ ...zero, batchNetFen: usable + 1n, usableBp: bp })).toEqual({
          ok: false,
          reason: 'watermark_usable_exceeded',
        });
      },
    ),
    propParams(),
  );
});

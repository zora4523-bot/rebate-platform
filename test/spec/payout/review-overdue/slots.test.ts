// B2-05n: the 5-minute slots of the payout-overdue chain (规划/08 BR-WDR-26: 超时检查任务每 5 分钟运行
// 一次，review_deadline 到达后 ≤5 分钟内判定; task brief §9.2 1: reviewOverdueSlot / nextReviewOverdueSlot,
// key `review-overdue:YYYY-MM-DDTHH:mm`, minutes rounded down to a multiple of 5, pure functions as
// risk/domain/risk-scan-slots: UTC keys, the current slot without a delay, the next one with the
// seconds until it is due, at least 1). Unit tests: no database, no port. Top-level it() only.
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  nextReviewOverdueSlot,
  reviewOverdueSlot,
} from '../../../../apps/api/src/modules/payout/index.ts';
import { NEXT_DELAY, NEXT_SLOT, NOW, SLOT } from './kit.ts';

const at = (text: string): Date => new Date(text);
const SLOT_MS = 5 * 60_000;

/** Instants (ms) from 2026-01-01 to the end of 2040, to the millisecond (32-bit parts). */
const INSTANTS = fc
  .tuple(fc.integer({ min: 0, max: 5_478 }), fc.integer({ min: 0, max: 86_399_999 }))
  .map(([day, ms]) => Date.parse('2026-01-01T00:00:00.000Z') + day * 86_400_000 + ms);

/** The instant a key names (UTC minute). */
function keyMs(key: string): number {
  const match = /^review-overdue:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(key);
  expect(match, key).not.toBeNull();
  return Date.parse(`${match?.[1] ?? ''}:00.000Z`);
}

it('[B2-05n 槽] 当前槽：键 review-overdue:<UTC 年月日时分>，分钟向下取整到 5 的倍数，不带延迟；整 5 分钟边界属于新槽', () => {
  const cases: [string, string][] = [
    [NOW.toISOString(), SLOT],
    ['2032-10-21T02:05:00.000Z', 'review-overdue:2032-10-21T02:05'],
    ['2032-10-21T02:09:59.999Z', 'review-overdue:2032-10-21T02:05'],
    ['2032-10-21T02:10:00.000Z', 'review-overdue:2032-10-21T02:10'],
    ['2032-10-21T02:04:59.999Z', 'review-overdue:2032-10-21T02:00'],
    ['2032-10-21T00:00:00.000Z', 'review-overdue:2032-10-21T00:00'],
    ['2032-10-20T23:59:59.999Z', 'review-overdue:2032-10-20T23:55'],
    ['2032-12-31T23:57:00.000Z', 'review-overdue:2032-12-31T23:55'],
  ];
  const seen = cases.map(([now]) => reviewOverdueSlot(at(now)));
  expect(seen).toStrictEqual(cases.map(([, key]) => ({ singletonKey: key })));
});

it('[B2-05n 槽] 下一槽：紧接当前槽之后的 5 分钟槽，延迟为到期前的秒数（不足 1 秒按 1 秒、向上取整，从不提前）；跨日、跨年', () => {
  const cases: [string, string, number][] = [
    [NOW.toISOString(), NEXT_SLOT, NEXT_DELAY],
    ['2032-10-21T02:05:00.000Z', 'review-overdue:2032-10-21T02:10', 300],
    ['2032-10-21T02:09:59.000Z', 'review-overdue:2032-10-21T02:10', 1],
    ['2032-10-21T02:09:59.500Z', 'review-overdue:2032-10-21T02:10', 1],
    ['2032-10-21T02:09:59.999Z', 'review-overdue:2032-10-21T02:10', 1],
    ['2032-10-21T02:06:00.001Z', 'review-overdue:2032-10-21T02:10', 240],
    ['2032-10-20T23:57:00.000Z', 'review-overdue:2032-10-21T00:00', 180],
    ['2032-12-31T23:55:00.000Z', 'review-overdue:2033-01-01T00:00', 300],
  ];
  const seen = cases.map(([now]) => nextReviewOverdueSlot(at(now)));
  expect(seen).toStrictEqual(
    cases.map(([, key, delaySeconds]) => ({ singletonKey: key, delaySeconds })),
  );
});

it('[B2-05n 槽] 性质：任一时刻 t，当前槽起点 ≤ t < 起点 + 5 分钟且分钟是 5 的倍数；下一槽起点 = 当前槽起点 + 5 分钟；1 ≤ 延迟 ≤ 300 且 t + 延迟秒 ≥ 下一槽起点 > t + 延迟秒 − 1 秒；入参不被改动、同一时刻结果相同', () => {
  fc.assert(
    fc.property(INSTANTS, (ms) => {
      const now = new Date(ms);
      const current = reviewOverdueSlot(now);
      const next = nextReviewOverdueSlot(now);
      expect(now.getTime()).toBe(ms);
      const start = keyMs(current.singletonKey);
      expect(start).toBeLessThanOrEqual(ms);
      expect(ms).toBeLessThan(start + SLOT_MS);
      expect(start % SLOT_MS).toBe(0);
      expect(current.delaySeconds).toBeUndefined();
      expect(keyMs(next.singletonKey)).toBe(start + SLOT_MS);
      const delay = next.delaySeconds ?? 0;
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(300);
      expect(ms + delay * 1000).toBeGreaterThanOrEqual(start + SLOT_MS);
      expect(ms + (delay - 1) * 1000).toBeLessThan(start + SLOT_MS);
      expect(reviewOverdueSlot(new Date(ms))).toStrictEqual(current);
      expect(nextReviewOverdueSlot(new Date(ms))).toStrictEqual(next);
    }),
    { numRuns: 300 },
  );
});

it('[BR-WDR-26 ≤5 分钟内判定] 任一 review_deadline：它落入的槽的下一槽到期时刻在 deadline 之后、5 分钟之内（链按槽运行即在到达后 ≤5 分钟内判定）', () => {
  fc.assert(
    fc.property(INSTANTS, (deadline) => {
      const next = keyMs(nextReviewOverdueSlot(new Date(deadline)).singletonKey);
      expect(next).toBeGreaterThan(deadline);
      expect(next - deadline).toBeLessThanOrEqual(SLOT_MS);
    }),
    { numRuns: 300 },
  );
});

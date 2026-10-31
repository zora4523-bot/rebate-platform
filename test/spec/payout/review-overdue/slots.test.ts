// B2-05n: the 5-minute slots of the payout-overdue chain (规划/08 BR-WDR-26: 超时检查任务每 5 分钟运行
// 一次，review_deadline 到达后 ≤5 分钟内判定; task brief §9.2 1: reviewOverdueSlot / nextReviewOverdueSlot,
// key `review-overdue:YYYY-MM-DDTHH:mm`, minutes rounded down to a multiple of 5, pure functions as
// risk/domain/risk-scan-slots: UTC keys, the current slot without a delay, the next one with the
// seconds until it is due, at least 1). Unit tests: no database, no port. Top-level it() only
// (规划/11 §4.3); the properties' runs and seed come from PROP_RUNS / PROP_SEED (@couli/testing),
// each body returns a boolean and the one assertion is outside fc.check; each property test first
// calls the functions under test on a fixed example.
import { propParams } from '@couli/testing';
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

/** The instant a key names (UTC minute); NaN when the key is not `review-overdue:<UTC minute>`. */
function keyMs(key: unknown): number {
  if (typeof key !== 'string') return Number.NaN;
  const match = /^review-overdue:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(key);
  if (match === null) return Number.NaN;
  return Date.parse(`${match[1] ?? ''}:00.000Z`);
}

/** The first counterexample of `holds` over INSTANTS (null when every run holds). */
function firstViolation(holds: (ms: number) => boolean): unknown {
  const details = fc.check(
    fc.property(INSTANTS, (ms) => holds(ms)),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  if (example === null) return { error: String(details.errorInstance) };
  return { instant: new Date(example[0]).toISOString() };
}

/** The slot property at one instant `ms` (see the test title). */
function slotsHold(ms: number): boolean {
  const now = new Date(ms);
  const current = reviewOverdueSlot(now);
  const next = nextReviewOverdueSlot(now);
  const start = keyMs(current.singletonKey);
  const delay = next.delaySeconds;
  return (
    now.getTime() === ms &&
    Number.isFinite(start) &&
    start <= ms &&
    ms < start + SLOT_MS &&
    start % SLOT_MS === 0 &&
    current.delaySeconds === undefined &&
    keyMs(next.singletonKey) === start + SLOT_MS &&
    typeof delay === 'number' &&
    Number.isInteger(delay) &&
    delay >= 1 &&
    delay <= 300 &&
    ms + delay * 1000 >= start + SLOT_MS &&
    ms + (delay - 1) * 1000 < start + SLOT_MS &&
    JSON.stringify(reviewOverdueSlot(new Date(ms))) === JSON.stringify(current) &&
    JSON.stringify(nextReviewOverdueSlot(new Date(ms))) === JSON.stringify(next)
  );
}

/** The ≤5-minute property at one review_deadline `deadline` (see the test title). */
function judgedInTime(deadline: number): boolean {
  const next = keyMs(nextReviewOverdueSlot(new Date(deadline)).singletonKey);
  return Number.isFinite(next) && next > deadline && next - deadline <= SLOT_MS;
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
  // A fixed example first (the skeleton's NotImplemented surfaces here).
  expect([reviewOverdueSlot(NOW), nextReviewOverdueSlot(NOW)]).toStrictEqual([
    { singletonKey: SLOT },
    { singletonKey: NEXT_SLOT, delaySeconds: NEXT_DELAY },
  ]);
  expect(firstViolation(slotsHold)).toBeNull();
});

it('[BR-WDR-26 ≤5 分钟内判定] 任一 review_deadline：它落入的槽的下一槽到期时刻在 deadline 之后、5 分钟之内（链按槽运行即在到达后 ≤5 分钟内判定）', () => {
  // DEADLINE 02:00:00Z falls in the 02:00 slot; the next one is due at 02:05 (5 minutes later).
  expect(nextReviewOverdueSlot(at('2032-10-21T02:00:00.000Z')).singletonKey).toBe(
    'review-overdue:2032-10-21T02:05',
  );
  expect(firstViolation(judgedInTime)).toBeNull();
});

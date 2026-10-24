// B2-06e ③ (规划/08 BR-WDR-14, BR-WDR-15; config payout.query_schedule): the pure schedule of
// application/query-schedule.ts. With T the first transfer attempt, point n < points_min.length is
// T + points_min[n] minutes, every later point interval_min minutes after the one before
// (defaults: T+1, +5, +30, +120 minutes, then +240, +360 …); manual_after_min (1440 = 24 hours) is
// reached when now − T ≥ manual_after_min minutes — exactly 24 hours is due.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  manualDue,
  queryPointOffsetSeconds,
  type QuerySchedule,
} from '../../../../apps/api/src/modules/payout/application/query-schedule.ts';

const DEFAULT: QuerySchedule = Object.freeze({
  points_min: Object.freeze([1, 5, 30, 120]),
  interval_min: 120,
  manual_after_min: 1440,
});
const MINUTE_S = 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const T = new Date('2026-10-19T02:00:00.000Z');

function after(ms: number): Date {
  return new Date(T.getTime() + ms);
}

it('[AC-B2-06e#3] 默认时点：point 0..3 为 T+1 / 5 / 30 / 120 分，之后每 120 分一次：point 4 = 240 分、point 5 = 360 分、point 6 = 480 分', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map((point) => queryPointOffsetSeconds(DEFAULT, point))).toEqual([
    1 * MINUTE_S,
    5 * MINUTE_S,
    30 * MINUTE_S,
    120 * MINUTE_S,
    240 * MINUTE_S,
    360 * MINUTE_S,
    480 * MINUTE_S,
  ]);
});

it('[AC-B2-06e#3] 默认配置下第 14 个时点是 T+22 小时、第 15 个恰为 T+24 小时（manual_after）', () => {
  expect([
    queryPointOffsetSeconds(DEFAULT, 13),
    queryPointOffsetSeconds(DEFAULT, 14),
    queryPointOffsetSeconds(DEFAULT, 15),
  ]).toEqual([1320 * MINUTE_S, 1440 * MINUTE_S, 1560 * MINUTE_S]);
});

it('[AC-B2-06e#3] 别的配置照读：points_min [3, 10]、interval 45 → 3 / 10 / 55 / 100 分；只有一个固定时点 [2]、interval 7 → 2 / 9 / 16 分', () => {
  const two: QuerySchedule = { points_min: [3, 10], interval_min: 45, manual_after_min: 600 };
  const one: QuerySchedule = { points_min: [2], interval_min: 7, manual_after_min: 600 };
  expect([0, 1, 2, 3].map((point) => queryPointOffsetSeconds(two, point))).toEqual([
    180, 600, 3300, 6000,
  ]);
  expect([0, 1, 2].map((point) => queryPointOffsetSeconds(one, point))).toEqual([120, 540, 960]);
});

it('[AC-B2-06e#3] 属性：任意配置与时点，固定时点取 points_min[n] 分，之后按 interval_min 分等距递增（整秒）', () => {
  expect(() =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.nat({ max: 400 }),
        (points, interval, point) => {
          const schedule: QuerySchedule = {
            points_min: points,
            interval_min: interval,
            manual_after_min: 1440,
          };
          const last = points.length - 1;
          const minutes =
            point <= last ? points[point]! : points[last]! + (point - last) * interval;
          return queryPointOffsetSeconds(schedule, point) === minutes * MINUTE_S;
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B2-06e#3] manual_after 1440 分的边界：恰 T+24 小时为到、过 1 毫秒为到；差 1 毫秒未到；T 当时与 T 之前未到', () => {
  expect([
    manualDue(DEFAULT, T, after(DAY_MS)),
    manualDue(DEFAULT, T, after(DAY_MS + 1)),
    manualDue(DEFAULT, T, after(DAY_MS - 1)),
    manualDue(DEFAULT, T, after(0)),
    manualDue(DEFAULT, T, after(-MINUTE_MS)),
  ]).toEqual([true, true, false, false, false]);
});

it('[AC-B2-06e#3] 属性：任意 manual_after_min 与时差，到期当且仅当 now − T ≥ manual_after_min 分（毫秒精度）', () => {
  expect(() =>
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: -DAY_MS, max: 100 * DAY_MS }),
        fc.boolean(),
        (manualAfter, delta, onEdge) => {
          const schedule: QuerySchedule = {
            points_min: [1, 5, 30, 120],
            interval_min: 120,
            manual_after_min: manualAfter,
          };
          // Half of the runs sit within a millisecond of the edge.
          const ms = onEdge ? manualAfter * MINUTE_MS + (delta % 2) : delta;
          const due = ms >= manualAfter * MINUTE_MS;
          return manualDue(schedule, T, after(ms)) === due;
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
});

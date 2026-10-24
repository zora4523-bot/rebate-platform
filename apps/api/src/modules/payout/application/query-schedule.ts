// B2-06e: the query schedule of an unknown payout result (规划/08 BR-WDR-14, BR-WDR-15; config
// payout.query_schedule). Pure functions; T is the time of the withdrawal's first transfer attempt.
//   queryPointOffsetSeconds(schedule, n)  seconds from T to query point n (n ≥ 0): n <
//                                         points_min.length → points_min[n] minutes; after the
//                                         last fixed point one point every interval_min minutes,
//                                         i.e. (points_min[last] + (n − last) × interval_min) min.
//                                         Defaults [1, 5, 30, 120] / 120: 1, 5, 30, 120, 240, 360 …
//   manualDue(schedule, T, now)           now − T ≥ manual_after_min minutes (exactly 24 hours with
//                                         the default 1440 is due): set needs_manual, alert, stop.
//   nextQueryPoint(schedule, T, now)      the first point n with T + offset(n) > now (the recovery
//                                         scan's point; a late job's next point is n + 1 of its own).
//   nextQueryDueMs(schedule, T, n)        when point n is due: T + offset(n), never later than
//                                         T + manual_after_min.
import type { PayoutChannelConfig } from './judgement.ts';

const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = 60_000;
/** Bound of the point search (a day of one-minute points is 1440; the default needs 15). */
const MAX_POINTS = 100_000;

/** payout.query_schedule as readPayoutChannelConfig returns it. */
export type QuerySchedule = PayoutChannelConfig['querySchedule'];

/** Seconds from the first transfer attempt T to query point `point` (BR-WDR-14). */
export function queryPointOffsetSeconds(schedule: QuerySchedule, point: number): number {
  const points = schedule.points_min;
  const last = points.length - 1;
  const n = Number.isInteger(point) && point >= 0 ? point : 0;
  // No fixed point at all (a configuration the reader never returns): one point every interval.
  if (last < 0) return (n + 1) * schedule.interval_min * SECONDS_PER_MINUTE;
  const fixed = points[Math.min(n, last)] as number;
  const minutes = n <= last ? fixed : fixed + (n - last) * schedule.interval_min;
  return minutes * SECONDS_PER_MINUTE;
}

/** True once `now` is at least manual_after_min minutes after T (BR-WDR-14 / BR-WDR-15). */
export function manualDue(schedule: QuerySchedule, firstTransferAt: Date, now: Date): boolean {
  return now.getTime() - firstTransferAt.getTime() >= schedule.manual_after_min * MS_PER_MINUTE;
}

/** The first point n with T + offset(n) > now (the next point still ahead); at most MAX_POINTS. */
export function nextQueryPoint(schedule: QuerySchedule, firstTransferAt: Date, now: Date): number {
  const elapsedMs = now.getTime() - firstTransferAt.getTime();
  let point = 0;
  while (point < MAX_POINTS && queryPointOffsetSeconds(schedule, point) * 1000 <= elapsedMs) {
    point += 1;
  }
  return point;
}

/**
 * The instant (ms) point `point` is due: T + offset(point), capped at T + manual_after_min so the
 * T + manual_after decision runs on time even when manual_after_min falls between two points.
 */
export function nextQueryDueMs(
  schedule: QuerySchedule,
  firstTransferAt: Date,
  point: number,
): number {
  const t = firstTransferAt.getTime();
  return Math.min(
    t + queryPointOffsetSeconds(schedule, point) * 1000,
    t + schedule.manual_after_min * MS_PER_MINUTE,
  );
}

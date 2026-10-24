// B2-06e: the query schedule of an unknown payout result (规划/08 BR-WDR-14, BR-WDR-15; config
// payout.query_schedule). Pure functions; T is the time of the withdrawal's first transfer attempt.
//   queryPointOffsetSeconds(schedule, n)  seconds from T to query point n (n ≥ 0): n <
//                                         points_min.length → points_min[n] minutes; after the
//                                         last fixed point one point every interval_min minutes,
//                                         i.e. (points_min[last] + (n − last) × interval_min) min.
//                                         Defaults [1, 5, 30, 120] / 120: 1, 5, 30, 120, 240, 360 …
//   manualDue(schedule, T, now)           now − T ≥ manual_after_min minutes (exactly 24 hours with
//                                         the default 1440 is due): set needs_manual, alert, stop.
import type { PayoutChannelConfig } from './judgement.ts';

/** payout.query_schedule as readPayoutChannelConfig returns it. */
export type QuerySchedule = PayoutChannelConfig['querySchedule'];

/** Seconds from the first transfer attempt T to query point `point` (BR-WDR-14). */
export function queryPointOffsetSeconds(schedule: QuerySchedule, point: number): number {
  void schedule;
  void point;
  throw new Error('NotImplemented: queryPointOffsetSeconds');
}

/** True once `now` is at least manual_after_min minutes after T (BR-WDR-14 / BR-WDR-15). */
export function manualDue(schedule: QuerySchedule, firstTransferAt: Date, now: Date): boolean {
  void schedule;
  void firstTransferAt;
  void now;
  throw new Error('NotImplemented: manualDue');
}

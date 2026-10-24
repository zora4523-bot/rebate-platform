// B2-15d unit tests of the close flow's rhythm (domain/close-schedule.ts; 08 BR-PAY-05 ②③ 细则).
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  afterExpire,
  closeMinutesOf,
  closeWaitOver,
  nextCloseRunAt,
  notExistMayClose,
  type CloseSettings,
} from './close-schedule.ts';

const DEFAULTS: CloseSettings = { graceMinutes: 10, retryMinutes: 5, waitMinutes: 60 };
const EXPIRE = new FixedClock('2026-10-25T04:00:00.000Z').now();
const MIN = 60_000;

function at(ms: number): Date {
  const d = structuredClone(EXPIRE);
  d.setTime(EXPIRE.getTime() + ms);
  return d;
}

describe('closeMinutesOf', () => {
  it('[AC-B2-15d#u1] absent is the default; a positive integer overrides; anything else falls back', () => {
    expect(closeMinutesOf(null, 10)).toEqual({ minutes: 10, fallback: false });
    expect(closeMinutesOf(undefined, 5)).toEqual({ minutes: 5, fallback: false });
    expect(closeMinutesOf(3, 10)).toEqual({ minutes: 3, fallback: false });
    for (const raw of [0, -1, 1.5, '3', true, {}]) {
      expect(closeMinutesOf(raw, 60)).toEqual({ minutes: 60, fallback: true });
    }
  });
});

describe('notExistMayClose / closeWaitOver', () => {
  it('[AC-B2-15d#u6] afterExpire moves a copy, never the given instant', () => {
    const before = EXPIRE.getTime();
    expect(afterExpire(EXPIRE, 10)).toEqual(at(10 * MIN));
    expect(EXPIRE.getTime()).toBe(before);
  });

  it('[AC-B2-15d#u2] the grace and the wait start at their own instant (now ≥ expire_at + minutes)', () => {
    expect(notExistMayClose(at(10 * MIN - 1), EXPIRE, DEFAULTS)).toBe(false);
    expect(notExistMayClose(at(10 * MIN), EXPIRE, DEFAULTS)).toBe(true);
    expect(closeWaitOver(at(60 * MIN - 1), EXPIRE, DEFAULTS)).toBe(false);
    expect(closeWaitOver(at(60 * MIN), EXPIRE, DEFAULTS)).toBe(true);
  });
});

describe('nextCloseRunAt', () => {
  it('[AC-B2-15d#u3] on the grid expire_at + k × retry, strictly after now', () => {
    expect(nextCloseRunAt(at(0), EXPIRE, DEFAULTS, false)).toEqual(at(5 * MIN));
    expect(nextCloseRunAt(at(55 * MIN), EXPIRE, DEFAULTS, false)).toEqual(at(60 * MIN));
    expect(nextCloseRunAt(at(7 * MIN), EXPIRE, DEFAULTS, false)).toEqual(at(10 * MIN));
    // Before expire_at (a cancel) the same grid applies.
    expect(nextCloseRunAt(at(-14 * MIN - 30_000), EXPIRE, DEFAULTS, false)).toEqual(at(-10 * MIN));
  });

  it('[AC-B2-15d#u4] two chains of one order at different instants of a slot land on the same run', () => {
    expect(nextCloseRunAt(at(MIN), EXPIRE, DEFAULTS, false)).toEqual(
      nextCloseRunAt(at(4 * MIN), EXPIRE, DEFAULTS, false),
    );
  });

  it('[AC-B2-15d#u5] never later than the wait point, nor than the grace point while a «not exist» waits', () => {
    const odd: CloseSettings = { graceMinutes: 3, retryMinutes: 10, waitMinutes: 25 };
    expect(nextCloseRunAt(at(20 * MIN), EXPIRE, odd, false)).toEqual(at(25 * MIN));
    expect(nextCloseRunAt(at(MIN), EXPIRE, odd, true)).toEqual(at(3 * MIN));
    expect(nextCloseRunAt(at(MIN), EXPIRE, odd, false)).toEqual(at(10 * MIN));
    expect(nextCloseRunAt(at(4 * MIN), EXPIRE, odd, true)).toEqual(at(10 * MIN));
  });
});

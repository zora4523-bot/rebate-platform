import { describe, expect, it } from 'vitest';
import { reviewDeadline, type WorkdayCalendarYear } from './review-deadline.ts';

const at = (iso: string) => new Date(iso);
const none: Readonly<Record<number, WorkdayCalendarYear>> = {};

describe('reviewDeadline (BR-WDR-26, 24 working hours)', () => {
  it('[AC-B2-05d#5] 08 examples: Fri 20:00 → Mon 20:00, Wed 10:00 → Thu 10:00, Sat 15:00 → Tue 00:00', () => {
    // 2026-10-23 is a Friday; 2026-10-21 a Wednesday; 2026-10-24 a Saturday (+08:00).
    expect(reviewDeadline(at('2026-10-23T12:00:00.000Z'), none).toISOString()).toBe(
      '2026-10-26T12:00:00.000Z',
    );
    expect(reviewDeadline(at('2026-10-21T02:00:00.000Z'), none).toISOString()).toBe(
      '2026-10-22T02:00:00.000Z',
    );
    expect(reviewDeadline(at('2026-10-24T07:00:00.000Z'), none).toISOString()).toBe(
      '2026-10-26T16:00:00.000Z',
    );
  });

  it('holidays skip and make-up workdays count, read from the civil year of each day', () => {
    const calendars = {
      2026: { holidays: ['2026-10-26'], makeupWorkdays: ['2026-10-25'] },
    };
    // Friday 20:00 → Sunday (make-up day) counts, Monday (holiday) does not.
    expect(reviewDeadline(at('2026-10-23T12:00:00.000Z'), calendars).toISOString()).toBe(
      '2026-10-25T12:00:00.000Z',
    );
    // Saturday 15:00 → Sunday make-up day 00:00 + 24h = Monday 00:00 +08:00.
    expect(reviewDeadline(at('2026-10-24T07:00:00.000Z'), calendars).toISOString()).toBe(
      '2026-10-25T16:00:00.000Z',
    );
  });

  it('refuses a calendar without any working day in the bound and an invalid instant', () => {
    const everyDayOff = {
      2026: {
        holidays: Array.from(
          { length: 31 },
          (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`,
        ).concat(Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)),
        makeupWorkdays: [],
      },
    };
    expect(() => reviewDeadline(at('2026-10-23T12:00:00.000Z'), everyDayOff)).toThrow(RangeError);
    expect(() => reviewDeadline(new Date(Number.NaN), none)).toThrow(RangeError);
  });
});

// B2-05d / BR-WDR-26: the manual review deadline is 24 WORKING hours after the application —
// the hours of the submission's working day that remain, then whole working days (00:00 – 24:00
// +08:00) until 24 hours are counted; a submission on a non-working day starts counting at 00:00
// of the next working day (08 examples: 周五 20:00 → 周一 20:00; 周三 10:00 → 周四 10:00; 周六 15:00
// → 周二 00:00). Working days: Monday – Friday unless listed as a holiday, plus the listed make-up
// workdays (the per-year calendar the console records, `calendar.cn_holidays.<year>` /
// `calendar.cn_makeup_workdays.<year>`, as risk's appeal calendar; an unconfigured year counts
// weekends only). Pure: no clock, no I/O, no `new Date` (dates derive from the given instant);
// the caller reads the calendars it needs.
export interface WorkdayCalendarYear {
  readonly holidays: readonly string[];
  readonly makeupWorkdays: readonly string[];
}

/** +08:00 (China Standard Time, no daylight saving). */
const OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const REVIEW_HOURS_MS = 24 * 3_600_000;
// 24 working hours never span more than the submission day plus the next 2 working days, and a
// non-working stretch is at most a long holiday; 16 days bounds every realistic calendar.
const SPAN_DAYS = 16;

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC midnight of day number `day` (days since 1970-01-01): its UTC fields are the +08:00 date. */
function civil(like: Date, day: number): Date {
  return dateAt(like, day * DAY_MS);
}

/** The +08:00 civil year of day number `day`. */
export function civilYearOfDay(like: Date, day: number): number {
  return civil(like, day).getUTCFullYear();
}

function isWorkingDay(
  like: Date,
  day: number,
  calendars: Readonly<Record<number, WorkdayCalendarYear>>,
): boolean {
  const date = civil(like, day);
  const calendar = calendars[date.getUTCFullYear()];
  if (calendar !== undefined) {
    const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    if (calendar.holidays.includes(text)) return false;
    if (calendar.makeupWorkdays.includes(text)) return true;
  }
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** The day numbers (days since 1970-01-01, +08:00 civil) a deadline from `from` may touch. */
export function reviewDeadlineDays(from: Date): { readonly first: number; readonly last: number } {
  const first = Math.floor((from.getTime() + OFFSET_MS) / DAY_MS);
  return { first, last: first + SPAN_DAYS };
}

/**
 * The review deadline (BR-WDR-26): `from` plus 24 working hours over the calendar.
 * Throws when the calendar never yields a working day within the bound (a broken calendar).
 */
export function reviewDeadline(
  from: Date,
  calendars: Readonly<Record<number, WorkdayCalendarYear>>,
): Date {
  const time = from.getTime();
  if (!Number.isFinite(time)) throw new RangeError('reviewDeadline: invalid start time');
  const { first, last } = reviewDeadlineDays(from);
  let remaining = REVIEW_HOURS_MS;
  // Hours left in the submission day, when it is a working day.
  if (isWorkingDay(from, first, calendars)) {
    const dayEnd = (first + 1) * DAY_MS - OFFSET_MS;
    const left = dayEnd - time;
    if (left >= remaining) return dateAt(from, time + remaining);
    remaining -= left;
  }
  // Then whole working days from 00:00 +08:00.
  for (let day = first + 1; day <= last; day += 1) {
    if (!isWorkingDay(from, day, calendars)) continue;
    const dayStart = day * DAY_MS - OFFSET_MS;
    if (DAY_MS >= remaining) return dateAt(from, dayStart + remaining);
    remaining -= DAY_MS;
  }
  throw new RangeError('reviewDeadline: no working day within the calendar bound');
}

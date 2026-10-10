// Processing deadline of an appeal (规划/08 BR-ID-36: 自提交时刻起第 3 个工作日 24:00（+08:00）前结案,
// 提交当日不计, 按国家法定工作日历含调休, 同 BR-ID-27; task B1-03i §9.3 #5).
// Pure: no clock, no configuration. A working day is Monday to Friday, minus the configured public
// holidays, plus the configured make-up working days (a holiday is never a working day even on a
// weekday; a make-up day is one even on a weekend). A year missing from `calendars` counts
// weekends only. The deadline is the end (24:00 +08:00, i.e. the next day's 00:00 +08:00) of the
// third working day after the +08:00 civil date of the submission.

/** B1-03i: dates are local civil dates in +08:00; the submission day is excluded. */
export interface AppealCalendarYear {
  readonly holidays: readonly string[];
  readonly makeupWorkdays: readonly string[];
}

/** +08:00 (China Standard Time, no daylight saving). */
const OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** BR-ID-36: the third working day after the submission day. */
const WORKING_DAYS = 3;

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isWorkingDay(
  date: Date,
  calendars: Readonly<Record<number, AppealCalendarYear>>,
): boolean {
  const calendar = calendars[date.getUTCFullYear()];
  if (calendar !== undefined) {
    const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    if (calendar.holidays.includes(text)) return false;
    if (calendar.makeupWorkdays.includes(text)) return true;
  }
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** The +08:00 civil year of `at` shifted by `shiftMs` (e.g. -1 for the day before a deadline). */
export function appealLocalYear(at: Date, shiftMs = 0): number {
  return dateAt(at, at.getTime() + shiftMs + OFFSET_MS).getUTCFullYear();
}

export function appealDeadline(
  submittedAt: Date,
  calendars: Readonly<Record<number, AppealCalendarYear>>,
): Date {
  const time = submittedAt.getTime();
  if (!Number.isFinite(time)) throw new RangeError('appealDeadline: invalid submission time');
  // Day number (days since 1970-01-01) of the +08:00 civil date of the submission.
  let day = Math.floor((time + OFFSET_MS) / DAY_MS);
  let counted = 0;
  while (counted < WORKING_DAYS) {
    day += 1;
    // UTC midnight of the civil day: its UTC fields are the +08:00 date.
    if (isWorkingDay(dateAt(submittedAt, day * DAY_MS), calendars)) counted += 1;
  }
  // 24:00 +08:00 of that day = 00:00 +08:00 of the next day.
  return dateAt(submittedAt, (day + 1) * DAY_MS - OFFSET_MS);
}

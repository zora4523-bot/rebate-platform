// Working-day calendar of the appeal deadline (BR-ID-36 处理时限, task B1-03i §9.3 #5).
// Per +08:00 civil year it reads `calendar.cn_holidays.<year>` and
// `calendar.cn_makeup_workdays.<year>` through the configuration port (values: arrays of
// `YYYY-MM-DD` strings of that year). A year whose two keys are not both configured with valid
// values, or whose read fails, counts weekends only, and one warn line
// `appeal_calendar_unconfigured` is logged for it with app_id and year only (never a value or the
// error): the calendar never refuses an appeal. Only the years the deadline actually reaches are
// read (a submission late in December may reach into January).
import type { Clock, RootLogger } from '../../platform/index.ts';
import {
  appealDeadline,
  appealLocalYear,
  type AppealCalendarYear,
} from '../domain/appeal-deadline.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

export interface AppealCalendarOptions {
  readonly appId: string;
  readonly clock: Clock;
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** An array of real `YYYY-MM-DD` dates of `year`; anything else is null (invalid). */
function datesOf(value: unknown, year: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const dates: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return null;
    const match = DATE.exec(entry);
    if (match === null || Number(match[1]) !== year) return null;
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    dates.push(entry);
  }
  return dates;
}

async function readYear(
  options: AppealCalendarOptions,
  year: number,
): Promise<AppealCalendarYear | null> {
  try {
    const [holidays, makeup] = await Promise.all([
      options.config.configValue(options.appId, `calendar.cn_holidays.${year}`),
      options.config.configValue(options.appId, `calendar.cn_makeup_workdays.${year}`),
    ]);
    if (holidays === null || makeup === null) return null;
    const holidayDates = datesOf(holidays.value, year);
    const makeupDates = datesOf(makeup.value, year);
    if (holidayDates === null || makeupDates === null) return null;
    return { holidays: holidayDates, makeupWorkdays: makeupDates };
  } catch {
    // The error may carry configuration values or driver details: never logged.
    return null;
  }
}

/** Read per-year configuration; unavailable/invalid calendars fall back with a private warning. */
export async function resolveAppealDeadline(options: AppealCalendarOptions): Promise<Date> {
  const submittedAt = options.clock.now();
  const firstYear = appealLocalYear(submittedAt);
  const calendars: Record<number, AppealCalendarYear> = {};
  const read = new Set<number>();
  for (;;) {
    let added = false;
    const deadline = appealDeadline(submittedAt, calendars);
    // The last working day counted is the civil day before the deadline instant.
    const lastYear = appealLocalYear(deadline, -1);
    for (let year = firstYear; year <= lastYear; year += 1) {
      if (read.has(year)) continue;
      read.add(year);
      added = true;
      const calendar = await readYear(options, year);
      if (calendar === null) {
        options.logger.warn({ app_id: options.appId, year }, 'appeal_calendar_unconfigured');
      } else {
        calendars[year] = calendar;
      }
    }
    // A newly read year may move the deadline into a later year: recompute until stable.
    if (!added) return deadline;
  }
}

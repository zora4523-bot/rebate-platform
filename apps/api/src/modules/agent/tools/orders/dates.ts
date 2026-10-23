// B3-08a · BR-AI-07: list_my_orders date checks. Pure integer day arithmetic, no Date overflow:
// '2025-13-01' or '2026-02-30' are refused, never rolled into another day.

const MS_PER_DAY = 86_400_000;
const PLUS_EIGHT_MS = 8 * 3_600_000;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Strict `YYYY-MM-DD` with a real calendar day; the day number, or null when not one. */
export function parseCalendarDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return daysFromCivil(year, month, day);
}

/** Today's day number in the +08:00 natural day of the given instant (the injected clock). */
export function plusEightDay(now: Date): number {
  return Math.floor((now.getTime() + PLUS_EIGHT_MS) / MS_PER_DAY);
}

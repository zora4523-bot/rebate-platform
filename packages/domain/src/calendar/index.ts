// +08:00 自然日 / 自然月原语（B1-08d）。纯函数：不读系统时区与系统时钟，不构造 Date。
// 时刻只经入参 `at.getTime()` 取得，按固定偏移 +08:00 用整数公历算法换算。

const MS_PER_DAY = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** 纪元日数 → 公历年月日（Howard Hinnant civil_from_days，适用于任意整数日）。 */
function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function assertFourDigitYear(year: number): void {
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(`year ${String(year)} is outside 0000-9999`);
  }
}

function chinaCivil(at: Date): CivilDate {
  if (!(at instanceof Date)) {
    throw new RangeError('expected a Date instance');
  }
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('invalid Date');
  }
  const civil = civilFromDays(Math.floor((ms + OFFSET_MS) / MS_PER_DAY));
  assertFourDigitYear(civil.year);
  return civil;
}

function formatMidnight(civil: CivilDate): string {
  assertFourDigitYear(civil.year);
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}T00:00:00+08:00`;
}

/** The instant's calendar date at the fixed offset +08:00, formatted YYYY-MM-DD. */
export function accountingDate(at: Date): string {
  const { year, month, day } = chinaCivil(at);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The instant's calendar month at the fixed offset +08:00, formatted YYYY-MM. */
export function chinaMonth(at: Date): string {
  const { year, month } = chinaCivil(at);
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

/** Strict YYYY-MM-DD input; [start, end) uses YYYY-MM-DDT00:00:00+08:00 strings. */
export function chinaDayRange(date: string): { start: string; end: string } {
  const match = typeof date === 'string' ? DATE_PATTERN.exec(date) : null;
  if (match === null) {
    throw new RangeError(`invalid date ${JSON.stringify(date)}; expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`date ${date} does not exist`);
  }
  let next: CivilDate;
  if (day < daysInMonth(year, month)) {
    next = { year, month, day: day + 1 };
  } else if (month < 12) {
    next = { year, month: month + 1, day: 1 };
  } else {
    next = { year: year + 1, month: 1, day: 1 };
  }
  return { start: formatMidnight({ year, month, day }), end: formatMidnight(next) };
}

/** Strict YYYY-MM input; [start, end) uses YYYY-MM-DDT00:00:00+08:00 strings. */
export function chinaMonthRange(month: string): { start: string; end: string } {
  const match = typeof month === 'string' ? MONTH_PATTERN.exec(month) : null;
  if (match === null) {
    throw new RangeError(`invalid month ${JSON.stringify(month)}; expected YYYY-MM`);
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    throw new RangeError(`month ${month} does not exist`);
  }
  const next: CivilDate =
    monthNumber < 12
      ? { year, month: monthNumber + 1, day: 1 }
      : { year: year + 1, month: 1, day: 1 };
  return { start: formatMidnight({ year, month: monthNumber, day: 1 }), end: formatMidnight(next) };
}

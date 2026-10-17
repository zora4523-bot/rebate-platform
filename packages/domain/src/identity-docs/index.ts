// 身份证件纯函数（B1-13c）：BR-ID-25 / BR-ID-26 / BR-WDR-02 ① ⑥。
// 纯函数：不读系统时钟与系统时区；时刻由调用方传入，按固定偏移 +08:00 用整数公历算法换算。
// 本模块不打日志（身份证号、姓名、卡号都是敏感数据）。

const MS_PER_DAY = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;
/** ECMAScript Date 可表示的最大绝对毫秒数。 */
const MAX_DATE_MS = 8_640_000_000_000_000;

const BIRTH_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RESIDENT_ID_PATTERN = /^\d{17}[\dX]$/;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK_CHARS = '10X98765432';
const CARD_PATTERN = /^\d{12,19}$/;
const NAME_SEPARATORS = /[•.．・]/g;
const MIDDLE_DOT = '·';

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

function isValidCivil(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** 公历年月日 → 纪元日数（Howard Hinnant days_from_civil，适用于任意整数年）。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** 纪元日数 → 公历年（civil_from_days 的年份部分）。 */
function yearFromDays(days: number): number {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  return yoe + era * 400 + (mp >= 10 ? 1 : 0);
}

function parseBirthDate(birthDate: string): CivilDate {
  const match = typeof birthDate === 'string' ? BIRTH_DATE_PATTERN.exec(birthDate) : null;
  if (match === null) {
    throw new RangeError('invalid birth date; expected YYYY-MM-DD');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCivil(year, month, day)) {
    throw new RangeError('birth date does not exist');
  }
  return { year, month, day };
}

function assertYears(years: number): void {
  if (typeof years !== 'number' || !Number.isSafeInteger(years) || years < 0) {
    throw new RangeError('years must be a non-negative integer');
  }
}

function instantMs(at: Date): number {
  if (!(at instanceof Date)) {
    throw new RangeError('expected a Date instance');
  }
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('invalid Date');
  }
  return ms;
}

/** 满 years 周岁时刻的纪元毫秒：第 years 个生日次日 00:00 +08:00（BR-ID-26）。 */
function thresholdMs(birth: CivilDate, years: number): number {
  const year = birth.year + years;
  let month = birth.month;
  let day = birth.day;
  if (month === 2 && day === 29 && !isLeapYear(year)) {
    month = 3;
    day = 1;
  }
  return (daysFromCivil(year, month, day) + 1) * MS_PER_DAY - OFFSET_MS;
}

function toDate(ms: number): Date {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) {
    throw new RangeError('age threshold is outside the Date range');
  }
  // 由计算所得的纪元毫秒构造返回值，不取当前时间；返回 Date 由规则测试骨架的签名规定。
  // eslint-disable-next-line no-restricted-syntax
  return new Date(ms);
}

function ageFromMs(birth: CivilDate, ms: number): number {
  const yearAt = yearFromDays(Math.floor((ms + OFFSET_MS) / MS_PER_DAY));
  let age = Math.max(0, yearAt - birth.year);
  while (age > 0 && thresholdMs(birth, age) > ms) age -= 1;
  while (thresholdMs(birth, age + 1) <= ms) age += 1;
  return age;
}

export type ResidentIdNoResult = { ok: true; id_no: string; birth_date: string } | { ok: false };

/** 18 位身份证：首尾 trim、末位 x 转 X，校验日期和 GB 11643 校验位。 */
export function parseResidentIdNo(input: string): ResidentIdNoResult {
  if (typeof input !== 'string') return { ok: false };
  let id = input.trim();
  if (id.length === 18 && id.endsWith('x')) id = id.slice(0, 17) + 'X';
  if (!RESIDENT_ID_PATTERN.test(id)) return { ok: false };

  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  if (!isValidCivil(year, month, day)) return { ok: false };

  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(id.charAt(i)) * ID_WEIGHTS[i]!;
  }
  if (ID_CHECK_CHARS.charAt(sum % 11) !== id.charAt(17)) return { ok: false };

  return {
    ok: true,
    id_no: id,
    birth_date: `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`,
  };
}

/** 第 years 个生日次日 00:00 +08:00；非闰年的 2 月 29 日生日按 3 月 1 日。 */
export function reachedAgeAt(birthDate: string, years: number): Date {
  const birth = parseBirthDate(birthDate);
  assertYears(years);
  return toDate(thresholdMs(birth, years));
}

/** 以生日次日为界的周岁，最小返回 0；非法日期或时刻抛 RangeError。 */
export function ageAt(birthDate: string, at: Date): number {
  const birth = parseBirthDate(birthDate);
  return ageFromMs(birth, instantMs(at));
}

export function isAtLeastAge(birthDate: string, years: number, at: Date): boolean {
  const birth = parseBirthDate(birthDate);
  assertYears(years);
  return instantMs(at) >= thresholdMs(birth, years);
}

/** NFKC → trim → 指定四种间隔符换成 U+00B7；保留中间空白。 */
export function normalizePersonName(input: string): string {
  return input.normalize('NFKC').trim().replace(NAME_SEPARATORS, MIDDLE_DOT);
}

export function samePersonName(a: string, b: string): boolean {
  return normalizePersonName(a) === normalizePersonName(b);
}

/** 仅移除 ASCII 空格和 ASCII 连字符，不清洗其他字符。 */
export function normalizeBankCardNo(input: string): string {
  return input.replace(/[ -]/g, '');
}

/** 输入必须是 12–19 位 ASCII 数字且通过 Luhn。 */
export function isValidBankCardNo(digits: string): boolean {
  if (typeof digits !== 'string' || !CARD_PATTERN.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

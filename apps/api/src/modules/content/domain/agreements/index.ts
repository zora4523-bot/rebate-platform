// F1-02m §9.2: agreement publish invariants (BR-ID-12, BR-WDR-31, 04 agreements). Pure: no clock,
// no storage; callers turn a failed result into 20001 with data.fields.
export type AgreementType = 'privacy' | 'agreement' | 'labor_agreement';

export interface AgreementVersion {
  readonly version: number;
  readonly min_version: number;
}

export interface AgreementPublishInput extends AgreementVersion {
  readonly type: AgreementType;
  readonly requires_resign: boolean;
  readonly legal_confirmed_by?: string | null;
  readonly legal_confirm_note?: string | null;
  readonly legal_confirmed_on?: string | null;
}

export type AgreementPublishResult = { ok: true } | { ok: false; fields: string[] };

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** A real Gregorian calendar day written exactly as YYYY-MM-DD. */
function isCalendarDay(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DAY.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function isNonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function validateAgreementPublish(
  input: AgreementPublishInput,
  current: AgreementVersion | null,
): AgreementPublishResult {
  const fields: string[] = [];
  const { version, min_version } = input;

  if (!Number.isInteger(version) || version !== (current?.version ?? 0) + 1) fields.push('version');

  const minOk =
    Number.isInteger(min_version) &&
    min_version >= 1 &&
    min_version <= version &&
    min_version >= (current?.min_version ?? 1);
  if (!minOk) fields.push('min_version');

  const expectedResign = input.type === 'labor_agreement' ? min_version === version : false;
  if (input.requires_resign !== expectedResign) fields.push('requires_resign');

  if (!isNonBlank(input.legal_confirmed_by)) fields.push('legal_confirmed_by');
  if (!isNonBlank(input.legal_confirm_note)) fields.push('legal_confirm_note');
  if (!isCalendarDay(input.legal_confirmed_on)) fields.push('legal_confirmed_on');

  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}

/** Labor agreements only; a missing current agreement is handled by the caller. */
export function needsSign(signedVersion: number | null, current: AgreementVersion): boolean {
  return signedVersion === null || signedVersion < current.min_version;
}

/** The oldest signed version still valid: signatures below it must be redone (BR-WDR-31). */
export function resignFromVersion(current: AgreementVersion): number {
  return current.min_version;
}

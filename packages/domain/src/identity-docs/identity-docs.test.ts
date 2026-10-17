import { expect, it } from 'vitest';
import {
  ageAt,
  isAtLeastAge,
  isValidBankCardNo,
  normalizeBankCardNo,
  normalizePersonName,
  parseResidentIdNo,
  reachedAgeAt,
} from './index.ts';

it('parseResidentIdNo rejects non-string input without throwing', () => {
  expect(parseResidentIdNo(undefined as unknown as string)).toEqual({ ok: false });
});

it('parseResidentIdNo accepts year 0000-02-29 (proleptic leap year) with a correct check digit', () => {
  // 000000 + 00000229 + 000 → weighted sum 2*9 + 2*10 + 9*5 = 83, 83 % 11 = 6 → check 6
  expect(parseResidentIdNo('000000000002290006')).toEqual({
    ok: true,
    id_no: '000000000002290006',
    birth_date: '0000-02-29',
  });
});

it('reachedAgeAt throws RangeError when the threshold leaves the Date range', () => {
  expect(() => reachedAgeAt('2000-01-01', 300_000)).toThrow(RangeError);
  expect(() => reachedAgeAt('2000-01-01', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
});

it('ageAt handles the instant just before 08:00 Beijing time on the day after the birthday', () => {
  // 2026-09-30T00:00+08:00 = 2026-09-29T16:00Z
  const before = reachedAgeAt('2012-09-29', 14);
  expect(before.toISOString()).toBe('2026-09-29T16:00:00.000Z');
  expect(ageAt('2012-09-29', before)).toBe(14);
  expect(isAtLeastAge('2012-09-29', 14, before)).toBe(true);
});

it('ageAt counts large ages exactly', () => {
  const at = reachedAgeAt('1900-03-01', 120);
  expect(ageAt('1900-03-01', at)).toBe(120);
});

it('normalizePersonName maps the halfwidth katakana middle dot via NFKC then to U+00B7', () => {
  expect(normalizePersonName('甲･乙')).toBe('甲·乙');
});

it('normalizeBankCardNo plus isValidBankCardNo accept a 19-digit Luhn number', () => {
  expect(isValidBankCardNo(normalizeBankCardNo('1234 5678 9012 3456 785'))).toBe(true);
});

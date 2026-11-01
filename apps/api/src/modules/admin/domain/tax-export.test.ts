import { expect, it } from 'vitest';
import { maskTaxIdNo, shanghaiInstant, TAX_EXPORT_HEADER, taxExportNote } from './tax-export.ts';

it('[AC-B2-08e] keeps the first 6 and the last 4 of an ID number and masks the rest', () => {
  expect(maskTaxIdNo('11010119900101123X')).toBe('110101********123X');
});

it('[AC-B2-08e] a value too short to hide anything keeps nothing', () => {
  expect(maskTaxIdNo('1234567890')).toBe('**********');
});

it('[AC-B2-08e] shows an instant at +08:00 without moving it, milliseconds included', () => {
  const instant = new Date('2026-12-31T15:59:59.999Z');
  const shown = shanghaiInstant(instant);
  expect(shown).toBe('2026-12-31T23:59:59.999+08:00');
  expect(Date.parse(shown)).toBe(instant.getTime());
});

it('[AC-B2-08e] the note names the account and the instant; the header has the 9 contract columns', () => {
  expect(taxExportNote('finance01', new Date('2026-10-09T02:00:00.000Z'))).toBe(
    '导出人：finance01；导出时刻：2026-10-09T10:00:00.000+08:00',
  );
  expect(new Set(TAX_EXPORT_HEADER).size).toBe(9);
});

// B1-22r / orchestrator ruling D10-427 ①, SPEC_REF 37808a5; contract AdminUnionOptionalReason
// (1–200 characters): the shared reason check of union's admin writes refuses any Unicode Cc
// control character and leaves every other valid reason as it was.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { validAdminUnionReason } from '../../../../apps/api/src/modules/union/domain/admin-reason.ts';
import { CC_CODE_POINTS, VALID_REASONS, controlReasons, shown } from './kit.ts';

it('[B1-22r][D10-427 ①] 不给原因照常通过；合法原因（200 字边界、中文、空格、非 Cc 的不可见字符）照常通过', () => {
  expect(validAdminUnionReason(undefined)).toBe(true);
  for (const reason of VALID_REASONS) {
    expect(validAdminUnionReason(reason), shown(reason)).toBe(true);
  }
});

it('[B1-22r][D10-427 ①] 全部 65 个 Cc 控制字符（U+0000–U+001F、U+007F–U+009F）在开头、中间、结尾都判不合格', () => {
  expect(CC_CODE_POINTS).toHaveLength(65);
  for (const code of CC_CODE_POINTS) {
    const control = String.fromCodePoint(code);
    for (const reason of [control, `${control}原因`, `更换${control}原因`, `原因${control}`]) {
      expect(validAdminUnionReason(reason), shown(reason)).toBe(false);
    }
  }
  for (const reason of controlReasons()) {
    expect(validAdminUnionReason(reason), shown(reason)).toBe(false);
  }
});

it('[B1-22r][D10-427 ①] 原有的长度与类型规则不变：空串、201 字、非字符串都判不合格', () => {
  for (const value of ['', '因'.repeat(201), 42, null, true, ['原因'], { reason: '原因' }]) {
    expect(validAdminUnionReason(value), JSON.stringify(value)).toBe(false);
  }
});

const isCc = (char: string) => CC_CODE_POINTS.includes(char.codePointAt(0)!);
/** BMP characters other than Cc and surrogates, so one character is one UTF-16 unit. */
const plainChar = fc
  .integer({ min: 0x20, max: 0xfffd })
  .filter((code) => (code < 0x7f || code > 0x9f) && (code < 0xd800 || code > 0xdfff))
  .map((code) => String.fromCodePoint(code));
const plainReason = fc
  .array(plainChar, { minLength: 1, maxLength: 199 })
  .map((chars) => chars.join(''));
const control = fc.constantFrom(...CC_CODE_POINTS).map((code) => String.fromCodePoint(code));

it('[B1-22r][D10-427 ①] 性质：不含 Cc 的 1–199 字原因合格；任意位置插入一个 Cc（总长不超过 200）就不合格', () => {
  fc.assert(
    fc.property(plainReason, control, fc.nat(), (reason, cc, at) => {
      expect([...reason].some(isCc)).toBe(false);
      expect(validAdminUnionReason(reason)).toBe(true);
      const index = at % (reason.length + 1);
      const withControl = `${reason.slice(0, index)}${cc}${reason.slice(index)}`;
      expect([...withControl].length).toBeLessThanOrEqual(200);
      expect(validAdminUnionReason(withControl)).toBe(false);
    }),
    propParams(),
  );
});

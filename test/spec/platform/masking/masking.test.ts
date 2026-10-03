// Rule tests for the default masking formats of 规划/08 BR-ID-33: 手机号 138****5678、身份证
// 1****************X（首 1 位 + 末 1 位）、姓名只显示末字（**三）. Inputs that are not a phone or
// an ID number of the stated form reveal nothing (contract in
// apps/api/src/modules/platform/masking/index.ts). Lengths count code points. Expected values
// are written out by hand. Top-level it() only (规划/11 §4.3); property runs and seed only from
// @couli/testing.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  maskIdNo,
  maskName,
  maskPhone,
} from '../../../../apps/api/src/modules/platform/masking/index.ts';

function stars(text: string): string {
  return '*'.repeat([...text].length);
}

it('[BR-ID-33] 手机号默认脱敏：前 3 位 + **** + 后 4 位（138****5678）', () => {
  expect(
    ['13812345678', '13987654321', '19900001111', '10000000000'].map((phone) => maskPhone(phone)),
  ).toEqual(['138****5678', '139****4321', '199****1111', '100****0000']);
});

it('[BR-ID-33] 手机号格式不符时不露任何字符：每个字符换成 *，空串仍是空串', () => {
  const inputs = [
    '',
    '1381234567',
    '138123456789',
    '+8613812345678',
    '8613812345678',
    '138 1234 5678',
    '138-1234-5678',
    '23812345678',
    '1381234567a',
    ' 13812345678',
    '13812345678\n',
    '１３８１２３４５６７８',
    '138123456７8',
  ];
  expect(inputs.map((phone) => maskPhone(phone))).toEqual(inputs.map(stars));
});

it('[BR-ID-33] 身份证默认脱敏：只露首 1 位与末 1 位（1****************X），15 位旧号同样', () => {
  expect(
    ['11010519491231002X', '11010519491231002x', '110105194912310021', '320105791231247'].map(
      (idNo) => maskIdNo(idNo),
    ),
  ).toEqual(['1****************X', '1****************x', '1****************1', '3*************7']);
});

it('[BR-ID-33] 身份证格式不符时不露任何字符：每个字符换成 *，空串仍是空串', () => {
  const inputs = [
    '',
    '1101051949123100',
    '11010519491231002',
    '1101051949123100211',
    '1101051949123100XX',
    'X10105194912310021',
    '11010519491231002Y',
    '110105 19491231002X',
    '32010579123124',
    '3201057912312470',
    '32010579123124X',
    '１１０１０５１９４９１２３１００２Ｘ',
    'E12345678',
  ];
  expect(inputs.map((idNo) => maskIdNo(idNo))).toEqual(inputs.map(stars));
});

it('[BR-ID-33] 姓名只显示末字：n 个字显示 n−1 个 * 加末字（**三），单字显示 *，按码点计', () => {
  expect(
    [
      '张小三',
      '李四',
      '欧阳明月',
      '王',
      '',
      '阿依古丽·买买提',
      '\u{20BB7}小三',
      '张\u{20BB7}',
      'John Smith',
    ].map((name) => maskName(name)),
  ).toEqual(['**三', '*四', '***月', '*', '', '*******提', '**三', '*\u{20BB7}', '*********h']);
});

// Generators: arbitrary strings (any code point, also lone surrogates) mixed with strings of the
// valid shapes, so both branches of every function are exercised in each run.
const anyText = fc.string({ unit: 'binary', maxLength: 24 });
const phoneShape = fc.stringMatching(/^1[0-9]{10}$/);
const idShape = fc.oneof(fc.stringMatching(/^[0-9]{17}[0-9Xx]$/), fc.stringMatching(/^[0-9]{15}$/));

function isPhone(text: string): boolean {
  return /^1[0-9]{10}$/.test(text);
}

function isIdNo(text: string): boolean {
  return /^[0-9]{17}[0-9Xx]$/.test(text) || /^[0-9]{15}$/.test(text);
}

it('[BR-ID-33] 任意字符串：手机号脱敏不抛错、码点数不变，合规号码只露前 3 后 4，其余全是 *', () => {
  let shaped = 0;
  fc.assert(
    fc.property(fc.oneof(anyText, phoneShape), (text) => {
      const out = maskPhone(text);
      if (!isPhone(text)) return out === stars(text);
      shaped += 1;
      return out === `${text.slice(0, 3)}****${text.slice(7)}`;
    }),
    propParams(),
  );
  expect(shaped).toBeGreaterThan(0);
});

it('[BR-ID-33] 任意字符串：身份证脱敏不抛错、码点数不变，合规号码只露首末各 1 位，其余全是 *', () => {
  let shaped = 0;
  fc.assert(
    fc.property(fc.oneof(anyText, idShape), (text) => {
      const out = maskIdNo(text);
      if (!isIdNo(text)) return out === stars(text);
      shaped += 1;
      return (
        out === `${text.charAt(0)}${'*'.repeat(text.length - 2)}${text.charAt(text.length - 1)}`
      );
    }),
    propParams(),
  );
  expect(shaped).toBeGreaterThan(0);
});

it('[BR-ID-33] 任意字符串：姓名脱敏不抛错、码点数不变，只有末一个码点保留（单字全遮）', () => {
  fc.assert(
    fc.property(anyText, (text) => {
      const chars = [...text];
      const out = [...maskName(text)];
      if (chars.length <= 1) return out.join('') === stars(text);
      return (
        out.length === chars.length &&
        out.slice(0, -1).every((c) => c === '*') &&
        out[out.length - 1] === chars[chars.length - 1]
      );
    }),
    propParams(),
  );
  expect(maskName('张小三')).toBe('**三');
});

import { isValidBankCardNo, normalizeBankCardNo } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
  ' -4111-- 1111 1111-1111- ',
  '4111111111111111',
])('[AC-B1-13c#16] 去 ASCII 空格与连字符后卡号有效：%j', (input) => {
  const digits = normalizeBankCardNo(input);
  expect(digits).toBe('4111111111111111');
  expect(isValidBankCardNo(digits)).toBe(true);
});

it.each([
  '123456789015',
  '1234567890128',
  '12345678901237',
  '123456789012347',
  '1234567890123452',
  '12345678901234569',
  '123456789012345671',
  '1234567890123456785',
  '000000000000',
])('[AC-B1-13c#17] 接受 12–19 位的 Luhn 有效号码，不检查 BIN：%s', (digits) => {
  expect(isValidBankCardNo(digits)).toBe(true);
});

it.each(Array.from({ length: 16 }, (_, index) => index))(
  '[AC-B1-13c#18] Luhn 有效样例第 %i 位改变后无效',
  (index) => {
    const digits = '4111111111111111';
    const changed = digits.slice(0, index) + '2' + digits.slice(index + 1);
    expect(isValidBankCardNo(changed)).toBe(false);
  },
);

it.each([
  '',
  '12345678903', // 11 位，Luhn 通过，长度不通过。
  '12345678901234567894', // 20 位，Luhn 通过，长度不通过。
  '00000000000',
  '00000000000000000000',
  '4111111111111112',
  '411111111111111A',
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
  ' 4111111111111111',
  '4111111111111111\n',
  '４１１１１１１１１１１１１１１１',
])('[AC-B1-13c#19] 纯校验函数不隐式清洗；格式或校验错误即 false：%j', (digits) => {
  expect(isValidBankCardNo(digits)).toBe(false);
});

it.each([
  '4111\t111111111111',
  '4111\n111111111111',
  '4111\r111111111111',
  '4111\u00a0111111111111',
  '4111\u3000111111111111',
  '4111–111111111111',
  '4111－111111111111',
  '4111_111111111111',
  '4111.111111111111',
  '4111A111111111111',
  '４１１１１１１１１１１１１１１１',
])('[AC-B1-13c#20] 规范化保留其他分隔符或非 ASCII 字符，使校验失败：%j', (input) => {
  const digits = normalizeBankCardNo(input);
  expect(digits).toBe(input);
  expect(isValidBankCardNo(digits)).toBe(false);
});

it.each(['', ' - -- '])('[AC-B1-13c#21] 清洗后的空卡号仍无效：%j', (input) => {
  const digits = normalizeBankCardNo(input);
  expect(digits).toBe('');
  expect(isValidBankCardNo(digits)).toBe(false);
});

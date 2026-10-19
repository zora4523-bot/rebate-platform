import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeAlipayLogonId } from './alipay-logon.ts';
import { maskAlipayLogonId, maskBankCardTail, maskPayeeName } from './mask-payout-account.ts';

interface Vector {
  readonly input: string;
  readonly note: string;
  readonly expected?: string;
  readonly error?: { readonly code: number; readonly reason?: string };
}

function vectors(file: string): readonly Vector[] {
  const url = new URL(`../../../../../../specs/${file}`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { cases: Vector[] }).cases;
}

it('[AC-B1-13e] alipay logon: every e-mail and phone vector normalises as listed', () => {
  const cases = [
    ...vectors('payout-logon-normalize.vectors.json'),
    ...vectors('phone-normalize.vectors.json'),
  ];
  expect(cases.length).toBeGreaterThan(40);
  for (const vector of cases) {
    const result = normalizeAlipayLogonId(vector.input);
    if (vector.expected !== undefined) {
      expect(result, vector.note).toEqual({ code: 0, logon: vector.expected });
    } else {
      expect(result, vector.note).toEqual({
        code: 20001,
        data: {
          fields: ['alipay_logon_id'],
          ...(vector.error?.reason === undefined ? {} : { reason: vector.error.reason }),
        },
      });
    }
  }
});

it('[AC-B1-13e] alipay logon: the 08 examples give one value per account', () => {
  for (const input of ['13800138000', '+86 138-0013-8000', '86 13800138000']) {
    expect(normalizeAlipayLogonId(input)).toEqual({ code: 0, logon: '13800138000' });
  }
  expect(normalizeAlipayLogonId('+852 5123 4567')).toMatchObject({
    code: 20001,
    data: { reason: 'phone_invalid' },
  });
  expect(normalizeAlipayLogonId('Zhang.San@Example.com')).toEqual({
    code: 0,
    logon: 'zhang.san@example.com',
  });
});

it('[AC-B1-13e] payout masks: BR-ID-33 细则 examples', () => {
  expect(maskAlipayLogonId('13812345678')).toBe('138****5678');
  expect(maskAlipayLogonId('zhangsan@example.com')).toBe('zh***@example.com');
  expect(maskAlipayLogonId('ab@x.com')).toBe('a***@x.com');
  expect(maskAlipayLogonId('a@x.com')).toBe('***@x.com');
  expect(maskAlipayLogonId('a@b@x.com')).toBe('*********');
  expect(maskBankCardTail('6222021234567890123')).toBe('尾号 0123');
  expect(maskBankCardTail('6222 0212')).toBe('*********');
  expect(maskPayeeName('张小三')).toBe('**三');
  expect(maskPayeeName('阿依古丽·买买提')).toBe('*******提');
});

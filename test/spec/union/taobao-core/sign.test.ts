import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import {
  signTaobaoParameters,
  taobaoTimestamp,
} from '../../../../apps/api/src/modules/union/infra/taobao/sign.ts';
import { md5, otherSecret, secret } from './kit.ts';

// Expected signatures are computed here with node:crypto from the TOP md5 rule in the task
// (synthetic secret, no recorded vector): drop empty values, ASCII-sort names, concatenate
// name + value, wrap both ends with the secret, MD5, uppercase hex.

it('[AC-B1-04j#1] concatenates name and value without separators, wraps both ends with the secret, uppercase MD5', () => {
  const signed = signTaobaoParameters({ b: '2', a: '1' }, secret);
  expect(signed).toBe(md5(`${secret}a1b2${secret}`));
  expect(signed).toMatch(/^[0-9A-F]{32}$/);
  expect(signTaobaoParameters({}, secret)).toBe(md5(`${secret}${secret}`));
  expect(signTaobaoParameters({ a: '1', b: '2' }, otherSecret)).toBe(
    md5(`${otherSecret}a1b2${otherSecret}`),
  );
  expect(signTaobaoParameters({ a: '1', b: '3' }, secret)).not.toBe(signed);
});

it('[AC-B1-04j#2] orders names by ASCII code units, not locale, independent of insertion order', () => {
  const parameters = Object.freeze({
    z: '5',
    method_x: 'm2',
    a: '4',
    _: '3',
    method: 'm1',
    Z: '2',
    B: 'b',
    A: '1',
  });
  const expected = md5(`${secret}A1BbZ2_3a4methodm1method_xm2z5${secret}`);
  expect(signTaobaoParameters(parameters, secret)).toBe(expected);
  expect(
    signTaobaoParameters(
      { A: '1', B: 'b', Z: '2', _: '3', a: '4', method: 'm1', method_x: 'm2', z: '5' },
      secret,
    ),
  ).toBe(expected);
});

it('[AC-B1-04j#3] drops undefined, null and empty-string values but signs 0 and false as text', () => {
  const parameters = Object.freeze({
    a: '1',
    empty: '',
    nothing: null,
    missing: undefined,
    f: false,
    z: 0,
  });
  expect(signTaobaoParameters(parameters, secret)).toBe(md5(`${secret}a1ffalsez0${secret}`));
  expect(signTaobaoParameters({ a: '1', f: false, z: 0 }, secret)).toBe(
    md5(`${secret}a1ffalsez0${secret}`),
  );
  expect(parameters).toEqual({
    a: '1',
    empty: '',
    nothing: null,
    missing: undefined,
    f: false,
    z: 0,
  });
});

it('[AC-B1-04j#4] the sign parameter itself never takes part and the input is not modified', () => {
  const parameters = Object.freeze({ sign: 'OLD-SIGN', a: '1' });
  expect(signTaobaoParameters(parameters, secret)).toBe(md5(`${secret}a1${secret}`));
  expect(parameters).toEqual({ sign: 'OLD-SIGN', a: '1' });
});

it('[AC-B1-04j#5] signs UTF-8 values as written, without URL encoding', () => {
  expect(signTaobaoParameters({ q: '汉字 &+=%20' }, secret)).toBe(
    md5(`${secret}q汉字 &+=%20${secret}`),
  );
});

// TODO(规划/11 §4.5): 数组 / 对象参数的签名形式待淘宝录制核对 — blocked on 淘宝录制
it('[AC-B1-04j#6] structured values sign as compact JSON, the same as their submitted string', () => {
  const ids = Object.freeze(['例子', 'a&b']);
  const range = Object.freeze({ min: 0, max: 10 });
  const expected = md5(`${secret}ids["例子","a&b"]range{"min":0,"max":10}${secret}`);
  expect(signTaobaoParameters(Object.freeze({ ids, range }), secret)).toBe(expected);
  expect(
    signTaobaoParameters({ ids: JSON.stringify(ids), range: JSON.stringify(range) }, secret),
  ).toBe(expected);
  expect(ids).toEqual(['例子', 'a&b']);
  expect(range).toEqual({ min: 0, max: 10 });
});

it('[AC-B1-04j#7] any set of non-empty string parameters follows the rule regardless of key order', () => {
  const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.]{0,11}$/).filter((n) => n !== 'sign');
  const value = fc.string({ minLength: 1, maxLength: 16 });
  fc.assert(
    fc.property(fc.dictionary(name, value, { maxKeys: 8 }), (parameters) => {
      const names = Object.keys(parameters).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const text = names.map((n) => `${n}${parameters[n]}`).join('');
      const expected = md5(`${secret}${text}${secret}`);
      expect(signTaobaoParameters(parameters, secret)).toBe(expected);
      const reversed = Object.fromEntries(Object.entries(parameters).reverse());
      expect(signTaobaoParameters(reversed, secret)).toBe(expected);
    }),
    propParams(),
  );
});

it.each([
  ['2026-10-30T15:55:42.000Z', '2026-10-30 23:55:42'],
  ['2026-12-31T16:00:00.000Z', '2027-01-01 00:00:00'],
  ['2026-01-02T01:02:03.999Z', '2026-01-02 09:02:03'],
  ['2028-02-28T16:30:05.500Z', '2028-02-29 00:30:05'],
  ['2026-06-30T15:59:59.999Z', '2026-06-30 23:59:59'],
])('[AC-B1-04j#8] timestamp of %s is %s in Beijing time', (iso, expected) => {
  expect(taobaoTimestamp(new Date(iso))).toBe(expected);
});

it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])(
  '[AC-B1-04j#9] timestamp does not depend on the process time zone (%s)',
  (zone) => {
    vi.stubEnv('TZ', zone);
    try {
      expect(taobaoTimestamp(new Date('2026-10-30T15:55:42.000Z'))).toBe('2026-10-30 23:55:42');
      expect(taobaoTimestamp(new Date('2026-03-08T10:30:00.000Z'))).toBe('2026-03-08 18:30:00');
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('[AC-B1-04j#10] timestamp is the UTC+8 wall clock to the second for any instant', () => {
  const hour = 3_600_000;
  fc.assert(
    fc.property(
      fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) }),
      (epochMs) => {
        const shifted = new Date(Math.floor(epochMs / 1000) * 1000 + 8 * hour).toISOString();
        const expected = `${shifted.slice(0, 10)} ${shifted.slice(11, 19)}`;
        const actual = taobaoTimestamp(new Date(epochMs));
        expect(actual).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(actual).toBe(expected);
      },
    ),
    propParams(),
  );
});

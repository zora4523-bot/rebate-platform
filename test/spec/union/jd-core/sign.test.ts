import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import {
  jdTimestamp,
  signJdParameters,
} from '../../../../apps/api/src/modules/union/infra/jd/sign.ts';
import { appKey, beijing, md5, method, otherSecret, secret } from './kit.ts';

// Expected signatures are computed here with node:crypto from the rule in the task (synthetic
// secret, no recorded vector): every parameter except `sign`, names in ascending byte order,
// concatenate name + value, wrap both ends with the secret, MD5, uppercase hex.

it('[AC-B1-04za#1] concatenates name and value without separators, wraps both ends with the secret, uppercase MD5', () => {
  const signed = signJdParameters({ b: '2', a: '1' }, secret);
  expect(signed).toBe(md5(`${secret}a1b2${secret}`));
  expect(signed).toMatch(/^[0-9A-F]{32}$/);
  expect(signJdParameters({ a: '1', b: '2' }, otherSecret)).toBe(
    md5(`${otherSecret}a1b2${otherSecret}`),
  );
  expect(signJdParameters({ a: '1', b: '3' }, secret)).not.toBe(signed);
});

it('[AC-B1-04za#2] the public parameters sign in byte order: 360buy_param_json comes before app_key', () => {
  const parameters = Object.freeze({
    v: '1.0',
    timestamp: beijing,
    sign_method: 'md5',
    method,
    format: 'json',
    '360buy_param_json': '{"q":"x"}',
    app_key: appKey,
  });
  const text =
    `${secret}360buy_param_json{"q":"x"}app_key${appKey}formatjson` +
    `method${method}sign_methodmd5timestamp${beijing}v1.0${secret}`;
  expect(signJdParameters(parameters, secret)).toBe(md5(text));
});

it('[AC-B1-04za#3] orders names by byte value, not locale, independent of insertion order', () => {
  const parameters = Object.freeze({
    z: '5',
    method_x: 'm2',
    a: '4',
    _: '3',
    method: 'm1',
    Z: '2',
    '3': 'd',
    A: '1',
  });
  const expected = md5(`${secret}3dA1Z2_3a4methodm1method_xm2z5${secret}`);
  expect(signJdParameters(parameters, secret)).toBe(expected);
  expect(
    signJdParameters(
      { '3': 'd', A: '1', Z: '2', _: '3', a: '4', method: 'm1', method_x: 'm2', z: '5' },
      secret,
    ),
  ).toBe(expected);
});

it('[AC-B1-04za#4] the sign parameter itself never takes part and the input is not modified', () => {
  const parameters = Object.freeze({ sign: 'OLD-SIGN', a: '1' });
  expect(signJdParameters(parameters, secret)).toBe(md5(`${secret}a1${secret}`));
  expect(parameters).toEqual({ sign: 'OLD-SIGN', a: '1' });
});

it('[AC-B1-04za#5] signs a Chinese business JSON as UTF-8 and values as written, without URL encoding', () => {
  const payload = '{"keyword":"汉字 &+=%20"}';
  expect(signJdParameters({ '360buy_param_json': payload }, secret)).toBe(
    md5(`${secret}360buy_param_json${payload}${secret}`),
  );
});

it('[AC-B1-04za#6] any set of parameters follows the rule regardless of key order', () => {
  const name = fc.stringMatching(/^[0-9A-Za-z][0-9A-Za-z_.]{0,11}$/).filter((n) => n !== 'sign');
  const value = fc.string({ minLength: 1, maxLength: 16 });
  expect(() =>
    fc.assert(
      fc.property(fc.dictionary(name, value, { maxKeys: 8 }), (parameters) => {
        const names = Object.keys(parameters).sort((a, b) =>
          Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
        );
        const text = names.map((n) => `${n}${parameters[n]}`).join('');
        const expected = md5(`${secret}${text}${secret}`);
        const reversed = Object.fromEntries(Object.entries(parameters).reverse());
        return (
          signJdParameters(parameters, secret) === expected &&
          signJdParameters(reversed, secret) === expected
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it.each([
  ['2026-10-30T15:55:42.000Z', '2026-10-30 23:55:42'],
  // Crosses into the next day at GMT+8.
  ['2026-10-30T16:00:00.000Z', '2026-10-31 00:00:00'],
  // Crosses into the next year at GMT+8.
  ['2026-12-31T16:00:00.000Z', '2027-01-01 00:00:00'],
  ['2026-12-31T15:59:59.999Z', '2026-12-31 23:59:59'],
  ['2026-01-02T01:02:03.999Z', '2026-01-02 09:02:03'],
  ['2028-02-28T16:30:05.500Z', '2028-02-29 00:30:05'],
])('[AC-B1-04za#7] timestamp of %s is %s at GMT+8', (iso, expected) => {
  expect(jdTimestamp(new Date(iso))).toBe(expected);
});

it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])(
  '[AC-B1-04za#8] timestamp does not depend on the process time zone (%s)',
  (zone) => {
    vi.stubEnv('TZ', zone);
    try {
      expect(jdTimestamp(new Date('2026-10-30T16:00:00.000Z'))).toBe('2026-10-31 00:00:00');
      expect(jdTimestamp(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01 00:00:00');
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('[AC-B1-04za#9] timestamp is the GMT+8 wall clock to the second for any instant', () => {
  const hour = 3_600_000;
  expect(() =>
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) }),
        (epochMs) => {
          const shifted = new Date(Math.floor(epochMs / 1000) * 1000 + 8 * hour).toISOString();
          const expected = `${shifted.slice(0, 10)} ${shifted.slice(11, 19)}`;
          const actual = jdTimestamp(new Date(epochMs));
          return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(actual) && actual === expected;
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
});

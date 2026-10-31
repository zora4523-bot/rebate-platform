import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  dataokeNonce,
  dataokeSignRan,
  dataokeTimer,
} from '../../../../apps/api/src/modules/union/infra/dataoke/sign.ts';
import { appKey, md5, nonce, otherSecret, secret, timer } from './kit.ts';

// Expected values are computed here with node:crypto from the new signature rule in the task
// (gz-41; synthetic secret, no recorded vector): MD5 of the text
// "appKey=<appKey>&timer=<timer>&nonce=<nonce>&key=<appSecret>", uppercase hex.

it('[AC-B1-04m#1] signRan is the uppercase MD5 of appKey=…&timer=…&nonce=…&key=<appSecret>', () => {
  const signed = dataokeSignRan({ appKey, timer, nonce }, secret);
  expect(signed).toBe(md5(`appKey=${appKey}&timer=${timer}&nonce=${nonce}&key=${secret}`));
  expect(signed).toMatch(/^[0-9A-F]{32}$/);
  expect(dataokeSignRan({ appKey, timer, nonce }, otherSecret)).toBe(
    md5(`appKey=${appKey}&timer=${timer}&nonce=${nonce}&key=${otherSecret}`),
  );
  // Each of the four values takes part.
  expect(dataokeSignRan({ appKey: 'other-app-key', timer, nonce }, secret)).not.toBe(signed);
  expect(dataokeSignRan({ appKey, timer: '1793375742124', nonce }, secret)).not.toBe(signed);
  expect(dataokeSignRan({ appKey, timer, nonce: '000043' }, secret)).not.toBe(signed);
  expect(dataokeSignRan({ appKey, timer, nonce }, otherSecret)).not.toBe(signed);
});

it('[AC-B1-04m#2] keeps the documented field order and uses values as written, without sorting or URL encoding', () => {
  const input = Object.freeze({ appKey: 'key with space&=汉字', timer: '0', nonce: '000000' });
  const odd = 'odd secret&=%20';
  const signed = dataokeSignRan(input, odd);
  expect(signed).toBe(md5('appKey=key with space&=汉字&timer=0&nonce=000000&key=odd secret&=%20'));
  // Alphabetical order (appKey, key, nonce, timer) and URL-encoded values are not the rule.
  expect(signed).not.toBe(md5(`appKey=${input.appKey}&key=${odd}&nonce=000000&timer=0`));
  expect(signed).not.toBe(
    md5(
      `appKey=${encodeURIComponent(input.appKey)}&timer=0&nonce=000000&key=${encodeURIComponent(odd)}`,
    ),
  );
  expect(input).toEqual({ appKey: 'key with space&=汉字', timer: '0', nonce: '000000' });
});

it('[AC-B1-04m#3] any appKey, timer, nonce and secret follow the text rule', () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 24 }),
      fc.integer({ min: 0, max: Date.UTC(2099, 11, 31) }),
      fc.integer({ min: 0, max: 999_999 }),
      fc.string({ minLength: 1, maxLength: 32 }),
      (key, epochMs, value, appSecret) => {
        const time = String(epochMs);
        const once = String(value).padStart(6, '0');
        const signed = dataokeSignRan({ appKey: key, timer: time, nonce: once }, appSecret);
        expect(signed).toBe(md5(`appKey=${key}&timer=${time}&nonce=${once}&key=${appSecret}`));
        expect(signed).toMatch(/^[0-9A-F]{32}$/);
      },
    ),
    propParams(),
  );
});

it.each([
  ['2026-10-30T15:55:42.123Z', '1793375742123'],
  ['2026-10-30T15:55:42.999Z', '1793375742999'],
  ['2026-01-01T00:00:00.000Z', '1767225600000'],
  ['1970-01-01T00:00:00.000Z', '0'],
])(
  '[AC-B1-04m#4] timer of %s is the millisecond timestamp %s, milliseconds kept',
  (iso, expected) => {
    expect(dataokeTimer(new Date(iso))).toBe(expected);
  },
);

it('[AC-B1-04m#5] timer is the decimal millisecond epoch of any instant', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: Date.UTC(2099, 11, 31) }), (epochMs) => {
      const actual = dataokeTimer(new Date(epochMs));
      expect(actual).toMatch(/^(0|[1-9]\d*)$/);
      expect(actual).toBe(String(epochMs));
    }),
    propParams(),
  );
});

it.each([
  [0, '000000'],
  [7, '000007'],
  [42, '000042'],
  [99_999, '099999'],
  [123_456, '123456'],
  [999_999, '999999'],
])('[AC-B1-04m#6] random value %i becomes the six-digit nonce %s', (value, expected) => {
  expect(dataokeNonce(value)).toBe(expected);
});

it('[AC-B1-04m#7] every integer in [0, 1000000) becomes exactly six digits with the same value', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 999_999 }), (value) => {
      const actual = dataokeNonce(value);
      expect(actual).toMatch(/^\d{6}$/);
      expect(Number(actual)).toBe(value);
    }),
    propParams(),
  );
});

it.each([
  -1,
  1_000_000,
  1_000_001,
  0.5,
  41.9,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
])(
  '[AC-B1-04m#8] random value %d is refused with a RangeError, never truncated or wrapped',
  (value) => {
    expect(() => dataokeNonce(value)).toThrow(RangeError);
  },
);

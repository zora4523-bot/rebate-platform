// B2-15k: implementer's unit tests of the Alipay primitives, ported from task/PAY-01.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alipayNotificationSignContent,
  alipayRequestSignContent,
  rsa2Sign,
  rsa2Verify,
} from './alipay-crypto.ts';
import { decodeDerString, rootCertSn } from './cert-sn.ts';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('alipay primitives', () => {
  it('[AC-B2-15k-U#20] the request string: sorted, no sign, no empty value, nothing encoded', () => {
    expect(
      alipayRequestSignContent({ b: '2 +', sign: 'x', a: '中', c: '', sign_type: 'RSA2' }),
    ).toBe('a=中&b=2 +&sign_type=RSA2');
  });

  it('[AC-B2-15k-U#21] the notification string: no sign, no sign_type, empty values stay', () => {
    expect(alipayNotificationSignContent({ b: '2', sign: 'x', a: '', sign_type: 'RSA2' })).toBe(
      'a=&b=2',
    );
  });

  it('[AC-B2-15k-U#22] RSA2 signs and verifies; a broken signature or key is false, never a throw', () => {
    const signature = rsa2Sign('content', pair.privateKey);
    expect(rsa2Verify('content', signature, pair.publicKey)).toBe(true);
    expect(rsa2Verify('other', signature, pair.publicKey)).toBe(false);
    expect(rsa2Verify('content', 'bm90', pair.publicKey)).toBe(false);
    expect(rsa2Verify('content', signature, 'not a key')).toBe(false);
  });

  it('[AC-B2-15k-U#23] ASN.1 strings decode by type and fail closed on the rest', () => {
    expect(decodeDerString(0x0c, Buffer.from('\uFEFF中', 'utf8'))).toBe('\uFEFF中');
    expect(decodeDerString(0x13, Buffer.from('Ab'))).toBe('Ab');
    expect(decodeDerString(0x16, Buffer.from('a@b'))).toBe('a@b');
    expect(decodeDerString(0x14, Buffer.from([0xe9]))).toBe('é');
    expect(decodeDerString(0x1e, Buffer.from([0x4e, 0x2d]))).toBe('中');
    expect(decodeDerString(0x1c, Buffer.from([0, 0, 0x4e, 0x2d]))).toBe('中');
    expect(() => decodeDerString(0x0c, Buffer.from([0xff]))).toThrow();
    expect(() => decodeDerString(0x13, Buffer.from([0xff]))).toThrow();
    expect(() => decodeDerString(0x1e, Buffer.from([0x4e]))).toThrow();
    expect(() => decodeDerString(0x1c, Buffer.from([0, 0, 0x4e]))).toThrow();
    expect(() => decodeDerString(0x03, Buffer.from([0]))).toThrow();
  });

  it('[AC-B2-15k-U#24] a truncated, polluted or empty root bundle is refused', () => {
    expect(() => rootCertSn('')).toThrow();
    expect(() => rootCertSn('-----BEGIN CERTIFICATE-----\nAAAA')).toThrow();
    expect(() => rootCertSn('text only')).toThrow();
  });
});

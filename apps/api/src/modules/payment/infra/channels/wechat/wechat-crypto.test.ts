// B2-15k: implementer's unit tests of the WeChat Pay primitives, ported from task/PAY-01.
import { createCipheriv, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptWechatResource,
  verifyWechatSignature,
  wechatAuthorization,
  wechatLaunchSign,
} from './wechat-crypto.ts';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY = 'k'.repeat(32);

function seal(plain: string, aad: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY), Buffer.from('abcdefghijkl'));
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

function verifies(message: string, signature: string): boolean {
  return createVerify('RSA-SHA256')
    .update(message, 'utf8')
    .verify(pair.publicKey, signature, 'base64');
}

describe('wechat primitives', () => {
  it('[AC-B2-15k-U#30] Authorization: the five-line message and the documented fields', () => {
    const header = wechatAuthorization({
      mchId: 'M1',
      merchantSerial: 'S1',
      privateKeyPem: pair.privateKey,
      method: 'POST',
      pathWithQuery: '/v3/x?a=1',
      body: '{}',
      timestamp: '100',
      nonce: 'n1',
    });
    expect(header.startsWith('WECHATPAY2-SHA256-RSA2048 mchid="M1",nonce_str="n1",')).toBe(true);
    expect(header).toContain('timestamp="100",serial_no="S1"');
    const signature = /signature="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(verifies('POST\n/v3/x?a=1\n100\nn1\n{}\n', signature)).toBe(true);
  });

  it('[AC-B2-15k-U#31] the launch signature covers appId, timestamp, nonce and prepay id', () => {
    const signature = wechatLaunchSign('A1', '100', 'n1', 'P1', pair.privateKey);
    expect(verifies('A1\n100\nn1\nP1\n', signature)).toBe(true);
  });

  it('[AC-B2-15k-U#32] answer signature: three lines; probe traffic and broken keys never pass', () => {
    const signature = wechatLaunchSign('100', 'n1', '{}', '', pair.privateKey);
    expect(verifyWechatSignature(pair.publicKey, '100', 'n1', '{}\n', signature)).toBe(true);
    expect(verifyWechatSignature(pair.publicKey, '100', 'n1', '{}', signature)).toBe(false);
    expect(
      verifyWechatSignature(pair.publicKey, '100', 'n1', '{}\n', `WECHATPAY/SIGNTEST/${signature}`),
    ).toBe(false);
    expect(verifyWechatSignature('not a key', '100', 'n1', '{}\n', signature)).toBe(false);
  });

  it('[AC-B2-15k-U#33] AES-256-GCM opens with key, nonce and associated data; any change throws', () => {
    const sealed = seal('{"a":"中"}', 'transaction');
    expect(decryptWechatResource(KEY, sealed, 'abcdefghijkl', 'transaction')).toBe('{"a":"中"}');
    expect(() => decryptWechatResource(KEY, sealed, 'abcdefghijkl', 'other')).toThrow();
    expect(() => decryptWechatResource(KEY, sealed, 'zzzzzzzzzzzz', 'transaction')).toThrow();
    expect(() =>
      decryptWechatResource('x'.repeat(32), sealed, 'abcdefghijkl', 'transaction'),
    ).toThrow();
    expect(() => decryptWechatResource(KEY, 'AAAA', 'abcdefghijkl', 'transaction')).toThrow();
  });
});

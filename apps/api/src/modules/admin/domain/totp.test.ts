import { expect, it } from 'vitest';
import { decodeBase32, hotp, totpTimeStep } from './totp.ts';

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥；运行时按 RFC 4648 编成 Base32。
const RFC_KEY_BASE32 = rfc4648Base32(Buffer.from('12345678901234567890', 'ascii'));
function rfc4648Base32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}

it('[AC-F1-06b-HOTP#1] RFC 4226 Appendix D values from the Base32 test key', () => {
  const key = decodeBase32(RFC_KEY_BASE32);
  expect(key.toString('ascii')).toBe('12345678901234567890');
  expect([0n, 1n, 2n, 3n, 9n].map((c) => hotp(key, c, 6))).toEqual([
    '755224',
    '287082',
    '359152',
    '969429',
    '520489',
  ]);
});

it('[AC-F1-06b-HOTP#2] Base32 rejects lower case and foreign characters; steps are 30 s from T0', () => {
  expect(() => decodeBase32('gezdgnbv')).toThrow(/Base32/);
  expect(() => decodeBase32('GEZD1')).toThrow(/Base32/);
  expect(() => decodeBase32('')).toThrow(/empty/);
  expect(decodeBase32('GEZDGNBV====').toString('ascii')).toBe('12345');
  expect(totpTimeStep(new Date(29_999))).toBe(0n);
  expect(totpTimeStep(new Date(30_000))).toBe(1n);
});

// Property test for platform/crypto field encryption (规划/08 BR-ID-33: AES-256-GCM 字段级加密，
// 密文带 key_version; 规划/11 §4.2). One property per top-level it(); the property body returns
// a boolean; one summary assertion after fc.assert; run count and seed only from
// @couli/testing. The plaintext is recovered with node:crypto (kit.ts), not only by the code
// under test. Tampering and context binding are checked exhaustively, bit by bit, in
// test/spec/platform/crypto/field-encryption.test.ts: a failed decryption costs far more than a
// successful one, which is too slow for a million runs.
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { IV_BYTES, TAG_BYTES, parseV1, referenceDecrypt } from '../../spec/platform/crypto/kit.ts';
import {
  CURRENT_VERSION,
  FULL_COVERAGE,
  PROPERTY_TIMEOUT_MS,
  bucketOf,
  contextUpTo,
  coverage,
  openKnown,
  plaintext,
} from './arb.ts';

it(
  '[BR-ID-33] 任意明文与 context：密文带当前 key_version、长度正好是 IV + 明文字节数 + tag，decrypt 还原原文，node:crypto 独立解密也得到原文',
  async () => {
    const { crypto, dataKey } = await openKnown();
    const key = dataKey(CURRENT_VERSION);
    const stats = createPropStats('platform:crypto:round-trip');
    fc.assert(
      fc.property(plaintext, contextUpTo(200), (text, context) => {
        stats.hit(bucketOf(text));
        const ciphertext = crypto.encrypt(text, context);
        const parsed = parseV1(ciphertext);
        return (
          parsed.version === CURRENT_VERSION &&
          parsed.payload.length === IV_BYTES + Buffer.byteLength(text, 'utf8') + TAG_BYTES &&
          crypto.decrypt(ciphertext, context) === text &&
          referenceDecrypt(key, ciphertext, context) === text
        );
      }),
      propParams(),
    );
    expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
  },
  PROPERTY_TIMEOUT_MS,
);

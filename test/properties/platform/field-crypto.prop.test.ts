// Property tests for platform/crypto field encryption (规划/08 BR-ID-33: AES-256-GCM 字段级加密，
// 密文带 key_version; 规划/11 §4.2). One property per top-level it(); the property body returns
// a boolean; one summary assertion after fc.assert; run count and seed only from
// @couli/testing. Expected plaintexts are checked with node:crypto (kit.ts), not only by the
// code under test.
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  IV_BYTES,
  TAG_BYTES,
  flipPayloadBit,
  outcomeOf,
  parseV1,
  referenceDecrypt,
} from '../../spec/platform/crypto/kit.ts';
import {
  CURRENT_VERSION,
  FULL_COVERAGE,
  bucketOf,
  contextUpTo,
  coverage,
  extraContextChar,
  openKnown,
  plaintext,
} from './arb.ts';

it('[BR-ID-33] 任意明文与 context：密文带当前 key_version、长度正好是 IV + 明文字节数 + tag，decrypt 还原原文，node:crypto 独立解密也得到原文', async () => {
  const { crypto, dataKey } = await openKnown();
  const stats = createPropStats('platform:crypto:round-trip');
  fc.assert(
    fc.property(plaintext, contextUpTo(200), (text, context) => {
      stats.hit(bucketOf(text));
      const ciphertext = crypto.encrypt(text, context);
      return (
        crypto.keyVersionOf(ciphertext) === CURRENT_VERSION &&
        parseV1(ciphertext).payload.length ===
          IV_BYTES + Buffer.byteLength(text, 'utf8') + TAG_BYTES &&
        crypto.decrypt(ciphertext, context) === text &&
        referenceDecrypt(dataKey(CURRENT_VERSION), ciphertext, context) === text
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-ID-33] 密文载荷的任意一位被翻转都解不开：抛 decrypt_failed，从不返回文本', async () => {
  const { crypto } = await openKnown();
  const stats = createPropStats('platform:crypto:tamper');
  fc.assert(
    fc.property(plaintext, contextUpTo(200), fc.nat(), (text, context, bit) => {
      stats.hit(bucketOf(text));
      const tampered = flipPayloadBit(crypto.encrypt(text, context), bit);
      return outcomeOf(() => crypto.decrypt(tampered, context)) === 'decrypt_failed';
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-ID-33] 任意两个不同的 context：一个 context 下加密的密文在另一个 context 下解不开，在原 context 下照常解开', async () => {
  const { crypto } = await openKnown();
  const stats = createPropStats('platform:crypto:context-binding');
  fc.assert(
    fc.property(plaintext, contextUpTo(199), extraContextChar, (text, context, extra) => {
      stats.hit(bucketOf(text));
      const other = context + extra;
      const ciphertext = crypto.encrypt(text, context);
      const moved = crypto.encrypt(text, other);
      return (
        outcomeOf(() => crypto.decrypt(ciphertext, other)) === 'decrypt_failed' &&
        outcomeOf(() => crypto.decrypt(moved, context)) === 'decrypt_failed' &&
        crypto.decrypt(ciphertext, context) === text &&
        crypto.decrypt(moved, other) === text
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

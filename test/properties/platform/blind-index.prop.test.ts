// Property tests for the platform/crypto blind index (规划/08 BR-ID-33: 另存 HMAC 盲索引用于去重
// 与查询; 规划/11 §4.2). One property per top-level it(); the property body returns a boolean;
// one summary assertion after fc.assert; run count and seed only from @couli/testing. The
// expected index is computed with node:crypto (kit.ts).
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { referenceBlindIndex } from '../../spec/platform/crypto/kit.ts';
import {
  FULL_COVERAGE,
  bucketOf,
  contextUpTo,
  coverage,
  extraContextChar,
  openKnown,
  plaintext,
  suffix,
} from './arb.ts';

it('[BR-ID-33] 任意值与 context：盲索引等于独立计算的 HMAC-SHA256(盲索引密钥, context ‖ 0x00 ‖ 值)，再算一次结果相同', async () => {
  const { crypto, blindKey } = await openKnown();
  const stats = createPropStats('platform:crypto:blind-index-reference');
  fc.assert(
    fc.property(plaintext, contextUpTo(200), (value, context) => {
      stats.hit(bucketOf(value));
      const index = crypto.blindIndex(value, context);
      return (
        index === referenceBlindIndex(blindKey, value, context) &&
        index === crypto.blindIndex(value, context)
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-ID-33] 任意两个不同的值在同一 context 下盲索引不同；同一个值换一个 context 盲索引也不同（去重不会把两个值并成一个）', async () => {
  const { crypto } = await openKnown();
  const stats = createPropStats('platform:crypto:blind-index-distinct');
  fc.assert(
    fc.property(
      plaintext,
      suffix,
      contextUpTo(199),
      extraContextChar,
      (value, more, context, extra) => {
        stats.hit(bucketOf(value));
        const index = crypto.blindIndex(value, context);
        return (
          index !== crypto.blindIndex(value + more, context) &&
          index !== crypto.blindIndex(value, context + extra)
        );
      },
    ),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

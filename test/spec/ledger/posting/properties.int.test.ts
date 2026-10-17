import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertPostingSequences } from '../../../properties/ledger/posting/sequences.ts';
import { TIMEOUT, close, open, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// PROP_RUNS=200 (PR), 2000 (long run); both count and seed come only from @couli/testing.
it(
  '[AC-B2-02f#23] PG 随机凭证序列：借贷平衡、缓存等于分录反号汇总、版本连续、重放无副作用',
  async () => {
    expect(await assertPostingSequences(h)).toBeGreaterThan(0);
  },
  TIMEOUT * 10,
);

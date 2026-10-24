// B2-06d ⑧: the entry of the frozen-amount property (frozen-property.ts) on real PostgreSQL.
import { createTestDatabase } from '@couli/db/testing';
import { propParams } from '@couli/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertFrozenInvariant, summarize } from './frozen-property.ts';
import { TIMEOUT, close, open, setup, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06d#8] 任意同步结果、复核拦截与重投序列下，每一步 frozen = Σ 非终态单金额、可用 + 冻结 + 已付 = 入金，PAID / RETURN 凭证与终态一一对应，每单至多转账一次', async () => {
  const f = await setup(h);
  const record = await assertFrozenInvariant(f);
  expect(summarize(record)).toEqual({ runs: propParams().numRuns, discards: 0, thin: [] });
}, 3_600_000);

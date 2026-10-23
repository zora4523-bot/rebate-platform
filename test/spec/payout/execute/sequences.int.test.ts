import { createTestDatabase } from '@couli/db/testing';
import { propParams } from '@couli/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assertExecuteSequences,
  summarize,
} from '../../../properties/domain/payout/execute-sequences.ts';
import { MINUTE, NOW, TIMEOUT, close, open, setup, snapshot, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06c#7] 随机 EXECUTE / W9 序列：同一单 execute_seq 逐次 +1，任务恰为 id:1…id:seq 各一条，不重复投递', async () => {
  const f = await setup(h);
  // The latest reading: far above any generated Σ (three withdrawals of at most 10^12 fen each).
  await f.watermark(10n ** 15n, new Date(NOW.getTime() - MINUTE), 'alipay');
  const service = f.execute();
  const before = await snapshot(f);
  const record = await assertExecuteSequences(f, service);
  expect({ ...summarize(record), after: await snapshot(f) }).toEqual({
    runs: propParams().numRuns,
    discards: 0,
    thin: [],
    after: before,
  });
}, 3_600_000);

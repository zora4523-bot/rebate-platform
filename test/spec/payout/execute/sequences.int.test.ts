import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertExecuteSequences } from '../../../properties/domain/payout/execute-sequences.ts';
import { TIMEOUT, close, open, setup, snapshot, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06c#7] 随机 EXECUTE / W9 序列：同一单 execute_seq 逐次 +1，任务恰为 id:1…id:seq 各一条，不重复投递', async () => {
  const f = await setup(h);
  const service = f.execute();
  const before = await snapshot(f);
  await assertExecuteSequences(f, service);
  expect(await snapshot(f)).toEqual(before);
}, 3_600_000);

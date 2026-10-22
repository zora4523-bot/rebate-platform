import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertWithdrawalSequences } from '../../../properties/domain/payout/withdrawal-sequences.ts';
import { setup, open, close, TIMEOUT, snapshot, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-05e#40] 随机 APPLY/APPROVE/REJECT 序列每一步 frozen 等于非终态金额，终态只有一笔退款', async () => {
  const f = await setup(h);
  const commands = f.commands();
  const before = await snapshot(f);
  await assertWithdrawalSequences(f, commands);
  expect(await snapshot(f)).toEqual(before);
}, 3_600_000);

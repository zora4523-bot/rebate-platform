import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { propParams } from '@couli/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ExecuteBatchInput } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import {
  assertAutoPayoutOnce,
  summarize,
} from '../../../properties/domain/payout/auto-payout-once.ts';
import { TIMEOUT, close, open, setup, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-11c#59] 任意投递 / 重投 / 人工 W2 / 人工 W3 顺序下每单至多一次 W2、至多一次系统 W2：先投递的恰一次系统 W2，人工先处理的没有', async () => {
  const f = await setup(h);
  const other = await f.member();
  const calls: ExecuteBatchInput[] = [];
  const consumer = f.consumer({
    execute: {
      async executeBatch(_trx, batch) {
        calls.push(batch);
        return { kind: 'executed', batchId: randomUUID(), paying: [...batch.members], left: [] };
      },
    },
  });
  const before = await f.events();
  const record = await assertAutoPayoutOnce({ f, other, consumer, calls });
  expect({ ...summarize(record), after: await f.events() }).toEqual({
    runs: propParams().numRuns,
    discards: 0,
    thin: [],
    after: before,
  });
}, 3_600_000);

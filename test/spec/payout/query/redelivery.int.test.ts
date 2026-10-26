// B2-06e ⑨ (规划/08 BR-WDR-14; 规划/12 §5.4; at-least-once delivery, AGENTS.md rule 5): the same
// query job delivered again. After three unknown tries the redelivery runs one more round of
// queries (attempts are records, not transfers) but the next point's job stays one row (same
// singletonKey); after a success the redelivery ends at ① (no longer PAYING): no query, no second
// voucher. The channel's transfer is never called.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MINUTE,
  TIMEOUT,
  UNKNOWN_STEP,
  at,
  balanceOf,
  close,
  jobsOf,
  open,
  queryJobRow,
  queryScripted,
  querySuccess,
  querySummary,
  setup,
  withdrawal,
  withdrawalVouchers,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06e#9] 三次未知后同一任务（同一 point）被重投：多一轮查询（共 6 次、6 行尝试），下一时点任务按去重键仍只有 1 条，单据仍 PAYING', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-5 * MINUTE));
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  const job = f.queryJobOf(w, 1);
  await handler(job);
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(6);
  expect(ch.transfers()).toBe(0);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 1, 1],
    ['unknown', 1, 1],
    ['unknown', 1, 2],
    ['unknown', 1, 2],
    ['unknown', 1, 3],
    ['unknown', 1, 3],
  ]);
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 2, 1500)]);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
});

it('[AC-B2-06e#9] 成功落库后同一任务被重投：在 ① 结束——不再查询、不再记账、单据不变', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(at(-5 * MINUTE), { userId: owner, net: 400n });
  const ch = queryScripted({
    [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`), querySuccess(`CH2${w.outBizNo}`)],
  });
  const handler = f.queryJob(ch.channel);
  const job = f.queryJobOf(w, 1);
  await handler(job);
  const row = await withdrawal(f, w.id);
  expect(row.status).toBe('PAID_API');
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(ch.transfers()).toBe(0);
  expect(await withdrawal(f, w.id)).toEqual(row);
  expect(await querySummary(f, w.id)).toEqual([['success', 1, 1]]);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:PAID`,
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_600n, frozen_fen: 0n });
  expect(await jobsOf(f, w.id)).toEqual([]);
});

it('[AC-B2-06e#9] 下一时点的任务接着执行（point 2）：成功即 W5，链条结束；point 2 的任务再被重投也只在 ① 结束', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-30 * MINUTE));
  const ch = queryScripted({
    [w.outBizNo]: [UNKNOWN_STEP, querySuccess(`CH${w.outBizNo}`)],
  });
  const handler = f.queryJob(ch.channel);
  const job = f.queryJobOf(w, 2);
  await expect(handler(job)).resolves.toBeUndefined();
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(2);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 2, 1],
    ['success', 2, 2],
  ]);
  expect((await withdrawal(f, w.id)).status).toBe('PAID_API');
  expect(await jobsOf(f, w.id)).toEqual([]);
});

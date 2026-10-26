// B2-06e ① ② ③ (规划/08 BR-WDR-14, BR-WDR-15): the query job's guards. ① a withdrawal that is
// missing (also: the payload's app is not the withdrawal's), no longer PAYING or of another
// execute_seq ends the job with nothing written — no channel call, no wait, no attempt, no job, no
// change; ② needs_manual = true means automatic queries have stopped (the same: nothing at all);
// ③ a PAYING withdrawal without any transfer attempt has no T: warn, nothing else.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  MINUTE,
  TIMEOUT,
  at,
  close,
  jobsOf,
  open,
  queryScripted,
  querySuccess,
  setup,
  snapshot,
  type Harness,
  type QueryFixture,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** T + 5 minutes: point 1 is due now. */
const T = at(-5 * MINUTE);

type Case = readonly [
  string,
  (f: QueryFixture) => Promise<{ job: ReceivedJob; id: string; outBizNo: string }>,
];

const CASES: readonly Case[] = [
  [
    '单据已是 PAID_API',
    async (f) => {
      const w = await f.seedPaying(T, { status: 'PAID_API' }, 'success');
      return { job: f.queryJobOf(w, 1), id: w.id, outBizNo: w.outBizNo };
    },
  ],
  [
    '单据已是 FAILED',
    async (f) => {
      const w = await f.seedPaying(T, { status: 'FAILED' });
      return { job: f.queryJobOf(w, 1), id: w.id, outBizNo: w.outBizNo };
    },
  ],
  [
    'execute_seq 与载荷不符（单据已被重新执行）',
    async (f) => {
      const w = await f.seedPaying(T, { executeSeq: 2 });
      return { job: f.queryJobOf(w, 1, { seq: 1 }), id: w.id, outBizNo: w.outBizNo };
    },
  ],
  [
    '载荷的 app_id 不是单据所在的 app',
    async (f) => {
      const w = await f.seedPaying(T);
      return {
        job: f.queryJobOf(w, 1, { appId: `${f.appId}_other` }),
        id: w.id,
        outBizNo: w.outBizNo,
      };
    },
  ],
  [
    '单据不存在',
    async (f) => {
      const w = await f.seedPaying(T);
      const id = randomUUID();
      return { job: f.queryJobOf({ ...w, id }, 1), id, outBizNo: w.outBizNo };
    },
  ],
];

it.each(CASES)(
  '[AC-B2-06e#1] %s：任务在 ① 结束，零副作用——不调用查询、不等待、不写尝试、不投任务、单据与余额不变',
  async (_label, make) => {
    const f = await setup(h);
    const { job, id, outBizNo } = await make(f);
    const ch = queryScripted({ [outBizNo]: [querySuccess(`CH${outBizNo}`)] });
    const handler = f.queryJob(ch.channel);
    const before = await snapshot(f);
    await expect(handler(job)).resolves.toBeUndefined();
    expect(ch.queries()).toEqual([]);
    expect(ch.transfers()).toBe(0);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
    expect(await jobsOf(f, id)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  },
);

it('[AC-B2-06e#2] needs_manual=true 的 PAYING 单：自动查询已停——不调用查询、不等待、不写尝试、不投任务、单据不变（未到 24 小时也一样）', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(T);
  await f.markNeedsManual(w);
  const ch = queryScripted({ [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] });
  const handler = f.queryJob(ch.channel);
  const before = await snapshot(f);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([]);
  expect(ch.transfers()).toBe(0);
  expect(f.sleep).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
  expect(await jobsOf(f, w.id)).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B2-06e#2] needs_manual=true 且已过 24 小时：同样直接结束，不再告警、不再改单', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-25 * 60 * MINUTE));
  await f.markNeedsManual(w);
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  const before = await snapshot(f);
  await expect(handler(f.queryJobOf(w, 15))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([]);
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'payout_needs_manual');
});

it('[AC-B2-06e#1] PAYING 但没有任何转账尝试（没有 T）：记 warn 后结束，不查询、不投任务、单据不变', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal();
  const ch = queryScripted({ [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] });
  const handler = f.queryJob(ch.channel);
  const before = await snapshot(f);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([]);
  expect(f.sleep).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
  expect(await jobsOf(f, w.id)).toEqual([]);
  expect(f.logger.warn).toHaveBeenCalled();
});

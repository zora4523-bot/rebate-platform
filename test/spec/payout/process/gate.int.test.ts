// B2-06d ① ② (规划/08 BR-WDR-13 ① ②, BR-WDR-14; 规划/12 §5.4 steps ① ②): a job whose withdrawal
// is not PAYING, or whose execute_seq is not the row's current one, ends with no effect at all; a
// PAYING withdrawal that already has a kind=transfer attempt (any result) is never transferred
// again: only the first query job is enqueued (B2-06e consumes it), before any review of ③.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  attempts,
  close,
  expectQueryJob,
  jobs,
  open,
  scripted,
  setup,
  snapshot,
  successStep,
  withdrawal,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const EARLIER = new Date(NOW.getTime() - 30_000);

it.each(['APPROVED', 'PAID_API', 'FAILED', 'REJECTED'] as const)(
  '[AC-B2-06d#1] 单据状态 %s（不是 PAYING）：任务直接结束，不调用通道，库里什么都不变',
  async (status) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ status });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    const before = await snapshot(f);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    expect(ch.transfers()).toEqual([]);
    expect(await snapshot(f)).toEqual(before);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);

it.each([
  [2, 1],
  [2, 3],
])(
  '[AC-B2-06d#1] 单据 execute_seq=%i、任务 execute_seq=%i（过期或不符）：直接结束，零副作用',
  async (rowSeq, jobSeq) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ executeSeq: rowSeq });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    const before = await snapshot(f);
    await expect(handler(f.jobOf(w, { seq: jobSeq }))).resolves.toBeUndefined();
    expect(ch.transfers()).toEqual([]);
    expect(await snapshot(f)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  },
);

it('[AC-B2-06d#1] 任务的 app_id 不是单据所属应用：按「没有这张单」结束，零副作用', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal();
  const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
  const handler = f.job(ch.channel);
  const before = await snapshot(f);
  await expect(handler(f.jobOf(w, { appId: `process_other_${w.id}` }))).resolves.toBeUndefined();
  expect(ch.transfers()).toEqual([]);
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B2-06d#1] ① 先于 ②：已回到 APPROVED 且有转账尝试的单（付款方侧失败后）不投递查询', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ status: 'APPROVED' });
  await f.seedAttempt(w.id, 'transfer', 'fail', EARLIER);
  const ch = scripted({});
  const handler = f.job(ch.channel);
  const before = await snapshot(f);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(ch.transfers()).toEqual([]);
  expect(await snapshot(f)).toEqual(before);
  expect(await jobs(f)).toEqual([]);
});

it.each(['pending', 'unknown', 'success', 'fail'] as const)(
  '[AC-B2-06d#2] PAYING 且已有 kind=transfer 尝试（result=%s）：不调用转账，只投递首个查询任务，单据与尝试不变',
  async (result) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal();
    await f.seedAttempt(w.id, 'transfer', result, EARLIER);
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    const before = await snapshot(f);
    const row = await withdrawal(f, w.id);
    const tried = await attempts(f, w.id);
    await expect(handler(f.jobOf(w, { attempt: 2 }))).resolves.toBeUndefined();
    expect(ch.transfers()).toEqual([]);
    expect(await withdrawal(f, w.id)).toEqual(row);
    expect(await attempts(f, w.id)).toEqual(tried);
    expectQueryJob(await jobs(f), w);
    const after = await snapshot(f);
    expect({ ...after, jobs: [] }).toEqual({ ...before, jobs: [] });
    expect(f.pause).not.toHaveBeenCalled();
  },
);

it('[AC-B2-06d#2] ② 先于 ③：已有转账尝试时即使 payout.enabled=off 也只查询，不走 W9', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal();
  await f.seedAttempt(w.id, 'transfer', 'pending', EARLIER);
  await f.set('payout.enabled', false);
  const ch = scripted({});
  const handler = f.job(ch.channel);
  const row = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(ch.transfers()).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(row);
  expect(row).toMatchObject({ status: 'PAYING', hold_reason: null });
  expectQueryJob(await jobs(f), w);
});

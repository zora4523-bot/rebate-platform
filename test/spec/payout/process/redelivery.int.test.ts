// B2-06d ⑦ (编排裁定 D10-223 ②; 规划/08 BR-WDR-13 ② ④, BR-WDR-14 "任何情况下都不得自动再次调用转账接口";
// 规划/12 §5.4 "进程在请求发出后崩溃"): the queue delivers at least once. Whenever the same job comes
// back — after a crash right after the pending attempt was committed, while the first delivery is
// still waiting on the channel (expiry), or after it finished — the channel's transfer is called
// exactly once in total; a redelivery of a PAYING withdrawal only enqueues the first query job
// (deduplicated by its singletonKey), one of a finished withdrawal ends at ①. Two deliveries
// running at once: the second waits on the first's row lock or daily lock until the first's pending
// attempt is committed, then sees it at ② (no second pass of ② before ④).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  UNKNOWN_STEP,
  attempts,
  close,
  expectQueryJob,
  gate,
  jobs,
  open,
  pauseFirstRead,
  queryJobs,
  reachedBefore,
  scripted,
  setup,
  successStep,
  waitAnyBlocked,
  waitUntil,
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

it('[AC-B2-06d#7] 写下 pending 尝试并提交后进程崩溃、任务被重投：第二次进入看到转账尝试，不再调用转账，只投递查询', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  // The state a crash between ④ (committed) and ⑤ leaves behind.
  await f.seedAttempt(w.id, 'transfer', 'pending', new Date(NOW.getTime() - 5_000));
  const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
  const handler = f.job(ch.channel);
  const row = await withdrawal(f, w.id);
  const tried = await attempts(f, w.id);
  await expect(handler(f.jobOf(w, { attempt: 2 }))).resolves.toBeUndefined();
  expect(ch.transfers()).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(row);
  expect(await attempts(f, w.id)).toEqual(tried);
  expectQueryJob(await jobs(f), w);
});

it('[AC-B2-06d#7] 第一次投递还卡在通道调用上时同一任务被重投：重投不转账；两次都结束后 transfer 恰好 1 次、转账尝试 1 行、查询任务 1 条', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  const stuck = gate();
  let inside = false;
  const ch = scripted(
    { [w.outBizNo]: [UNKNOWN_STEP] },
    {
      after: async () => {
        inside = true;
        await stuck.wait();
      },
    },
  );
  const handler = f.job(ch.channel);
  const first = handler(f.jobOf(w));
  let reached = false;
  try {
    reached = await waitUntil(() => inside);
    await expect(handler(f.jobOf(w, { attempt: 2 }))).resolves.toBeUndefined();
    expect(ch.transfers()).toHaveLength(1);
  } finally {
    stuck.open();
  }
  await expect(first).resolves.toBeUndefined();
  expect(reached).toBe(true);
  expect(ch.transfers()).toHaveLength(1);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
  ]);
  expectQueryJob(await jobs(f), w);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
});

it('[AC-B2-06d#7] 两次投递同时进行（确定性双连接）：A 过了 ① ② 停在日锁内的复核上，B 进入同一任务必须等 A 的行锁或日锁；A 写 pending 并提交后 B 看到转账尝试只走查询，transfer 恰好 1 次', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  const ch = scripted({ [w.outBizNo]: [UNKNOWN_STEP] });
  // A's first read of payout.enabled (③'s first check) stops it after ① and ②, before ④.
  const paused = pauseFirstRead(f, 'payout.enabled');
  const handler = f.job(ch.channel, { config: paused.config });
  const first = handler(f.jobOf(w));
  first.catch(() => undefined);
  let second: Promise<unknown> | undefined;
  let reached = false;
  let waited = false;
  let during: { attempts: number; transfers: number } | undefined;
  try {
    reached = await reachedBefore(paused.inside, first);
    if (reached) {
      second = handler(f.jobOf(w, { attempt: 2 }));
      second.catch(() => undefined);
      waited = await waitAnyBlocked(f);
      during = { attempts: (await attempts(f, w.id)).length, transfers: ch.transfers().length };
    }
  } finally {
    paused.resume.open();
  }
  await expect(first).resolves.toBeUndefined();
  expect(reached).toBe(true);
  await expect(second).resolves.toBeUndefined();
  expect(waited).toBe(true);
  expect(during).toEqual({ attempts: 0, transfers: 0 });
  expect(ch.transfers()).toHaveLength(1);
  expect(ch.transfers()[0]!.outBizNo).toBe(w.outBizNo);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
  ]);
  expectQueryJob(await jobs(f), w);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
});

it('[AC-B2-06d#7] 结果未知后任务再被投递两次：transfer 仍恰好 1 次，查询任务按去重键只有 1 条', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  const ch = scripted({ [w.outBizNo]: [UNKNOWN_STEP, successStep(`CH${w.outBizNo}`)] });
  const handler = f.job(ch.channel);
  const job = f.jobOf(w);
  await handler(job);
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  await expect(handler({ ...job, attempt: 3 })).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect(await attempts(f, w.id)).toHaveLength(1);
  expect(queryJobs(await jobs(f))).toHaveLength(1);
  expectQueryJob(await jobs(f), w);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
});

it('[AC-B2-06d#7] 成功落库后任务被重投：在 ① 结束（已不是 PAYING），不转账、不查询、不再记账', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  const ch = scripted({
    [w.outBizNo]: [successStep(`CH${w.outBizNo}`), successStep(`CH2${w.outBizNo}`)],
  });
  const handler = f.job(ch.channel);
  const job = f.jobOf(w);
  await handler(job);
  const row = await withdrawal(f, w.id);
  expect(row.status).toBe('PAID_API');
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect(await withdrawal(f, w.id)).toEqual(row);
  expect(await jobs(f)).toEqual([]);
});

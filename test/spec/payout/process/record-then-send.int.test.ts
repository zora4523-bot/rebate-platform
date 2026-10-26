// B2-06d ④ ⑤ (规划/08 BR-WDR-13 ③ ④ ⑤; 规划/12 §5.4 steps ④ ⑤; db/migrations/0081 payout_attempts):
// the review and the pending attempt happen inside pg_advisory_xact_lock(hashtext('payout_daily:'
// || app_id)); the attempt (kind transfer, result pending, masked request, at = Clock.now) is
// committed — visible to another connection, the lock released — before the channel is called;
// after the call the same row is completed once (response, resp_code, resp_sub_code, result,
// latency_ms). The request goes out with the withdrawal's snapshot (out_biz_no, net_fen, payee).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LOGON_ID,
  NOW,
  PAYEE_NAME,
  TIMEOUT,
  attempts,
  close,
  dailyLockFree,
  dailyLockKey,
  expectNoPayeeInLogs,
  holdDailyLock,
  open,
  pauseFirstRead,
  reachedBefore,
  scripted,
  setup,
  successStep,
  waitAnyBlocked,
  waitBlockedBy,
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

type Attempts = Awaited<ReturnType<typeof attempts>>;

it.each(['alipay', 'bank_card'] as const)(
  '[AC-B2-06d#5] 先记后发（%s）：转账发出时 pending 尝试已提交、另一连接可见、单据仍 PAYING、日锁已释放；之后同一行一次补完',
  async (channel) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ net: 1234n, channel });
    const seen: { attempts: Attempts; status: string; lockFree: boolean }[] = [];
    const ch = scripted(
      { [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] },
      {
        latencyMs: 321,
        before: async () => {
          seen.push({
            attempts: await attempts(f, w.id),
            status: (await withdrawal(f, w.id)).status,
            lockFree: await dailyLockFree(f),
          });
        },
      },
    );
    const handler = f.job(ch.channel);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

    expect(ch.transfers()).toEqual([
      {
        outBizNo: w.outBizNo,
        netFen: 1234n,
        payee: { identity: LOGON_ID, name: PAYEE_NAME },
        channel,
      },
    ]);
    expect(f.decryptPayee).toHaveBeenCalledWith(expect.any(Buffer), channel);
    expect(seen).toEqual([
      {
        attempts: [
          {
            id: expect.any(String),
            app_id: f.appId,
            withdrawal_id: w.id,
            kind: 'transfer',
            request: expect.anything(),
            response: null,
            resp_code: null,
            resp_sub_code: null,
            result: 'pending',
            latency_ms: null,
            at: NOW,
          },
        ],
        status: 'PAYING',
        lockFree: true,
      },
    ]);
    const pending = seen[0]!.attempts[0]!;
    // The request summary is masked: never the payee's account or name in plain text.
    const summary = JSON.stringify(pending.request);
    expect(summary).not.toContain(LOGON_ID);
    expect(summary).not.toContain(PAYEE_NAME);

    const done = await attempts(f, w.id);
    expect(done).toEqual([
      {
        ...pending,
        response: expect.anything(),
        resp_code: '10000',
        resp_sub_code: null,
        result: 'success',
        latency_ms: 321,
      },
    ]);
    expect(done[0]!.response).not.toBeNull();
    expectNoPayeeInLogs(f);
  },
);

it('[AC-B2-06d#5] 复核与写 pending 在 payout_daily 锁内：别的连接持锁时任务在锁上等待，不写尝试、不转账；锁释放后才继续', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 1000n });
  const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
  const handler = f.job(ch.channel);
  const lock = await holdDailyLock(f);
  let observed: { attempts: Attempts; transfers: number } | undefined;
  let waited = false;
  const run = handler(f.jobOf(w));
  try {
    waited = await waitBlockedBy(f, lock.pid);
    observed = { attempts: await attempts(f, w.id), transfers: ch.transfers().length };
  } finally {
    await lock.release();
  }
  await expect(run).resolves.toBeUndefined();
  expect(waited).toBe(true);
  expect(observed).toEqual({ attempts: [], transfers: 0 });
  expect(ch.transfers()).toHaveLength(1);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'success' }),
  ]);
});

it('[AC-B2-06d#5] pending 尝试在 payout_daily 锁释放前已提交（确定性栅栏）：任务在锁内复核时另一连接在日锁上等待，拿到锁的那一刻已看得到 result=pending 的转账尝试，通道还没被调用', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 1000n });
  let observed = false;
  // The transfer waits (bounded) until the waiter has looked: what it saw cannot include ⑤.
  const ch = scripted(
    { [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] },
    {
      before: async () => {
        await waitUntil(() => observed);
      },
    },
  );
  // The first read of payout.enabled (③'s first check) stops the job inside the daily lock.
  const paused = pauseFirstRead(f, 'payout.enabled');
  const handler = f.job(ch.channel, { config: paused.config });
  const run = handler(f.jobOf(w));
  run.catch(() => undefined);
  let reached = false;
  let held = false;
  let waited = false;
  let waiter: Promise<{ attempts: Attempts; transfers: number }> | undefined;
  try {
    reached = await reachedBefore(paused.inside, run);
    if (reached) {
      held = !(await dailyLockFree(f));
      waiter = f.h.observer
        .transaction()
        .execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${dailyLockKey(f.appId)}))`.execute(trx);
          return { attempts: await attempts(f, w.id, trx), transfers: ch.transfers().length };
        })
        .finally(() => {
          observed = true;
        });
      waiter.catch(() => undefined);
      waited = await waitAnyBlocked(f);
    }
  } finally {
    paused.resume.open();
  }
  await expect(run).resolves.toBeUndefined();
  expect(reached).toBe(true);
  expect(held).toBe(true);
  expect(waited).toBe(true);
  expect(await waiter).toEqual({
    attempts: [
      expect.objectContaining({
        withdrawal_id: w.id,
        kind: 'transfer',
        result: 'pending',
        response: null,
        at: NOW,
      }),
    ],
    transfers: 0,
  });
  expect(ch.transfers()).toHaveLength(1);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'success' }),
  ]);
});

it('[AC-B2-06d#5] 同一应用的两个任务在日锁上串行：第二单的复核看得到第一单已提交的 pending 尝试', async () => {
  const f = await setup(h);
  await f.set('payout.daily_cap_fen', 1000);
  const first = await f.seedWithdrawal({ net: 700n });
  const second = await f.seedWithdrawal({ net: 700n });
  const ch = scripted({});
  const handler = f.job(ch.channel);
  const lock = await holdDailyLock(f);
  const runs = [handler(f.jobOf(first)), handler(f.jobOf(second))];
  let waited = false;
  try {
    waited = await waitBlockedBy(f, lock.pid);
  } finally {
    await lock.release();
  }
  await Promise.all(runs);
  expect(waited).toBe(true);
  const holds = [
    (await withdrawal(f, first.id)).hold_reason,
    (await withdrawal(f, second.id)).hold_reason,
  ].sort();
  expect(holds).toEqual(['daily_cap', null]);
  expect(ch.transfers()).toHaveLength(1);
});

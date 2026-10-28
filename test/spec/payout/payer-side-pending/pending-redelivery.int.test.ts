// B2-06h rule tests (规划/08 BR-WDR-17, BR-WDR-13 ②, BR-WDR-14, BR-WDR-28; B2-06g money r1 S2): a
// payer-side code (payout.payer_side_codes) judged by the release, then completeAttempt itself fails
// with a transient database error — the transfer attempt stays result=pending with response NULL.
// The payout process has judged the result already (paused and alerted, B2-06g), so neither the
// redelivered release (② sees a transfer attempt) nor the query chain may treat the withdrawal as an
// ordinary unknown: it is W9 back to APPROVED with hold_reason payer_side_after_transfer, no query
// job is sent, no W6 FAILED with WITHDRAW:RETURN refunds the member, the channel is never called
// again. Control: an ordinary unknown result (neither payer side nor pausing) whose completeAttempt
// fails the same way still goes to the query (one first query job, still PAYING).
// Real PostgreSQL through the B2-06d / B2-06e kits (process/kit.ts, query/kit.ts, read only): the
// payout process's transfer handler on couli_payout (one instance per test: one process), the
// worker's review on couli_app. The transient error is injected once, on the couli_payout handle,
// on the first UPDATE of payout_attempts (the attempt's completion). The query handler is built
// apart from the transfer handler, as payout-runtime.ts builds the two (no object shared between
// them but the process's handles, queue, clock and config).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DEALING_STEP,
  PAYER_SIDE_STEP,
  TIMEOUT,
  attempts,
  balanceOf,
  changes,
  close,
  expectNoPayeeInLogs,
  expectQueryJob,
  jobs,
  open,
  queryJobs,
  scripted,
  settle,
  setup,
  withdrawal,
  withdrawalVouchers,
  type Harness,
} from '../process/kit.ts';
import { QUERY_FAIL_STEP, QUERY_LISTS, setup as querySetup } from '../query/kit.ts';
import {
  alertCount,
  expectPayerSideHeld,
  isAttemptCompletion,
  jobsOf,
  landJobs,
  onFirstStatement,
  pauseJobs,
  releaseOf,
  scriptedBoth,
  transient,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-06h#1] 付款方侧失败已识别、completeAttempt 遇瞬时 PG 错误（尝试仍 pending、response 为空）：重投的 release 在 ② 认出付款方异常，W9 hold_reason=payer_side_after_transfer，不发查询、不再转账、不走 W6、不退回余额；对照：普通未知结果的 completeAttempt 同样失败，重投后照旧恰一条首个查询、单据仍 PAYING',
  async () => {
    const f = await setup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    const ch = scripted({ [w.outBizNo]: [PAYER_SIDE_STEP] });
    const balance = await balanceOf(f, owner);
    const hooked = onFirstStatement(f.h.payout, isAttemptCompletion, () => {
      throw transient();
    });
    // One payout process: the same transfer handler instance for every job below.
    const handler = f.rawJob(ch.channel, { db: hooked.db, attemptsDb: hooked.db });

    const first = await settle(handler(f.jobOf(w)));
    expect(hooked.seen()).toBe(true);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(alertCount(f, w, 'payer_side')).toBe(1);
    // Either the hold landed on this call, or the call rejected so the queue redelivers it.
    const landedAtOnce = (await withdrawal(f, w.id)).status === 'APPROVED';
    expect(landedAtOnce || !first.ok).toBe(true);
    expect(queryJobs(jobsOf(await jobs(f), w))).toEqual([]);

    // The queue redelivers the release: ② sees the transfer attempt, recognises the judged
    // payer-side result and holds instead of sending the first query.
    expect(await settle(handler(releaseOf(w, 2)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);

    // Another redelivery repeats nothing.
    expect(await settle(handler(releaseOf(w, 3)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(alertCount(f, w)).toBe(1);
    expect(pauseJobs(await jobs(f))).toHaveLength(1);
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);

    // Control (its own app: the pause above is per app): 10000 without SUCCESS is unknown and
    // does not pause; its completeAttempt fails once the same way.
    const g = await setup(h);
    const c = await g.seedWithdrawal({ net: 800n });
    const cch = scripted({ [c.outBizNo]: [DEALING_STEP] });
    const cBalance = await balanceOf(g, g.userId);
    const cHooked = onFirstStatement(g.h.payout, isAttemptCompletion, () => {
      throw transient();
    });
    const control = g.rawJob(cch.channel, { db: cHooked.db, attemptsDb: cHooked.db });

    await settle(control(g.jobOf(c)));
    expect(cHooked.seen()).toBe(true);
    expect(await settle(control(releaseOf(c, 2)))).toEqual({ ok: true });
    expect(await withdrawal(g, c.id)).toMatchObject({
      status: 'PAYING',
      hold_reason: null,
      hold_at: null,
      execute_seq: c.executeSeq,
    });
    const cAttempts = await attempts(g, c.id);
    expect(cAttempts.map((row) => row.kind)).toEqual(['transfer']);
    expect(['pending', 'unknown']).toContain(cAttempts[0]?.result);
    const cRows = await jobs(g);
    expectQueryJob(cRows, c);
    expect(landJobs(cRows)).toEqual([]);
    expect(pauseJobs(cRows)).toEqual([]);
    expect(alertCount(g, c)).toBe(0);
    expect(cch.transfers().map((r) => r.outBizNo)).toEqual([c.outBizNo]);
    expect(await changes(g)).toEqual([]);
    expect(await withdrawalVouchers(g)).toEqual([`wd:${c.id}:FREEZE`]);
    expect(await balanceOf(g, g.userId)).toEqual(cBalance);
  },
  TIMEOUT,
);

it(
  '[AC-B2-06h#2] 付款方侧失败已识别、completeAttempt 遇瞬时 PG 错误后，release 重投之前该单的查询任务先到（如恢复扫描补投）：查询链也认出付款方异常，即使通道查询返回明确失败也不走 W6、不退回余额，W9 hold_reason=payer_side_after_transfer、不再排下一个查询点；之后重投的 release 不再转账、不重复留单',
  async () => {
    const f = await querySetup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    const ch = scriptedBoth(QUERY_LISTS, {
      [w.outBizNo]: {
        transfer: [PAYER_SIDE_STEP],
        // A query answer query_status_map maps to fail: an ordinary query chain lands W6 (refund).
        query: [QUERY_FAIL_STEP, QUERY_FAIL_STEP, QUERY_FAIL_STEP],
      },
    });
    const balance = await balanceOf(f, owner);
    const hooked = onFirstStatement(f.h.payout, isAttemptCompletion, () => {
      throw transient();
    });
    // One payout process: its transfer handler and, built apart, its query handler (both on
    // couli_payout); the query handler is followed by the worker's turn (landing and pause jobs).
    const transfer = f.rawJob(ch.channel, { db: hooked.db, attemptsDb: hooked.db });
    const query = f.withAutoLand(
      f.rawQueryJob(ch.channel, { db: f.h.payout, attemptsDb: f.h.payout }),
    );

    const first = await settle(transfer(f.jobOf(w)));
    expect(hooked.seen()).toBe(true);
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(alertCount(f, w, 'payer_side')).toBe(1);
    const landedAtOnce = (await withdrawal(f, w.id)).status === 'APPROVED';
    expect(landedAtOnce || !first.ok).toBe(true);
    const rows = await jobs(f);
    expect(queryJobs(jobsOf(rows, w))).toEqual([]);
    expect(pauseJobs(rows)).toHaveLength(1);

    // Before the queue redelivers the release, a query job of point 0 for w is delivered.
    await expect(query(f.queryJobOf(w, 0))).resolves.toBeUndefined();
    await expectPayerSideHeld(f, w);
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(await balanceOf(f, owner)).toEqual(balance);

    // The release redelivered afterwards: no transfer, no second hold.
    expect(await settle(transfer(releaseOf(w, 2)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w);
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(alertCount(f, w)).toBe(1);
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

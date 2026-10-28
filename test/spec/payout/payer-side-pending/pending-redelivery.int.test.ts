// B2-06h rule tests (规划/08 BR-WDR-17, BR-WDR-13 ②, BR-WDR-14, BR-WDR-28; B2-06g money r1 S2): a
// payer-side code (payout.payer_side_codes) judged by the release, then completeAttempt itself fails
// with a transient database error — the transfer attempt stays result=pending with response NULL.
// The payout process has judged the result already (paused and alerted, B2-06g), so neither the
// redelivered release (② sees a transfer attempt) nor the query chain may treat the withdrawal as an
// ordinary unknown: it is W9 back to APPROVED with hold_reason payer_side_after_transfer, no query
// job is sent, no W6 FAILED with WITHDRAW:RETURN refunds the member, the channel is never called
// again. Once the same process landed the hold on a healthy database, the attempt carries the
// channel's code (40004 / TEST_PAYER_SIDE).
// Controls (spec-test review r1) — the hold belongs to the judged payer-side result only:
//   - an ordinary unknown (10000 without SUCCESS, no pause) and an unknown that pauses (a code in
//     none of the lists: pauseAndAlert runs too, cause unknown_code) whose completeAttempt fails
//     the same way still go to the query: one first query job, still PAYING, and the query chain
//     lands what the query answers (a definite fail: W6 with the refund);
//   - a transfer attempt pending with response NULL that was never judged (the payout process
//     crashed between ④ and the completion), in the same app and on the same handlers that just
//     held a payer-side one: the redelivered release sends the first query, a definite fail lands
//     W6 with wd:{id}:RETURN, a success W5.
// [AC-B2-06h#3] (review r1 S2): an outage over the whole landing (completion and W9 both fail):
// the release rejects, the redelivery on the same handler still holds, nothing is refunded.
// Real PostgreSQL through the B2-06d / B2-06e kits (process/kit.ts, query/kit.ts, read only): the
// payout process's transfer handler on couli_payout (one instance per test: one process), the
// worker's review on couli_app. The transient error is injected on the couli_payout handle, on the
// first UPDATE of payout_attempts (the attempt's completion): once, or from there on until healed.
// The query handler is built apart from the transfer handler, as payout-runtime.ts builds the two
// (no object shared between them but the process's handles, queue, clock and config).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DEALING_STEP,
  MINUTE,
  PAYER_SIDE_STEP,
  TIMEOUT,
  UNLISTED_STEP,
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
import {
  QUERY_FAIL_STEP,
  QUERY_LISTS,
  at,
  queryJobRow,
  querySuccess,
  setup as querySetup,
} from '../query/kit.ts';
import {
  FIRST_QUERY_S,
  alertCount,
  expectPayerSideHeld,
  isAttemptCompletion,
  jobsOf,
  landJobs,
  onFirstStatement,
  outageFrom,
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

/** When the crashed process wrote ④ of the never-judged controls (past point 0, not yet manual). */
const CRASHED_AT = at(-2 * MINUTE);

it(
  '[AC-B2-06h#1] 付款方侧失败已识别、completeAttempt 遇瞬时 PG 错误（尝试仍 pending、response 为空）：重投的 release 在 ② 认出付款方异常，W9 hold_reason=payer_side_after_transfer，尝试补记 40004 / TEST_PAYER_SIDE，不发查询、不再转账、不走 W6、不退回余额；对照：普通未知结果与须暂停的未知码（同样先暂停告警）的 completeAttempt 同样失败，重投后照旧恰一条首个查询、单据仍 PAYING，查询明确失败照旧 W6 退回',
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
    // payer-side result and holds instead of sending the first query. The same process on a
    // healthy database: the attempt now carries the channel's code.
    expect(await settle(handler(releaseOf(w, 2)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w, { recorded: true });
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);

    // Another redelivery repeats nothing.
    expect(await settle(handler(releaseOf(w, 3)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w, { recorded: true });
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

    // Control (its own app): a code in none of the lists is unknown and pauses — pauseAndAlert
    // runs as for the payer-side code (cause unknown_code) — and its completeAttempt fails once
    // the same way. The money may have been paid (BR-WDR-28: unknown), so it stays PAYING and
    // goes to the query; the query handler (built apart) lands what the query answers.
    const u = await querySetup(h);
    const uOwner = await u.newUser(3_000n);
    const d = await u.seedWithdrawal({ userId: uOwner, net: 600n });
    const uch = scriptedBoth(QUERY_LISTS, {
      [d.outBizNo]: { transfer: [UNLISTED_STEP], query: [QUERY_FAIL_STEP] },
    });
    expect(await balanceOf(u, uOwner)).toEqual({ available_fen: 2_400n, frozen_fen: 600n });
    const uHooked = onFirstStatement(u.h.payout, isAttemptCompletion, () => {
      throw transient();
    });
    const uTransfer = u.rawJob(uch.channel, { db: uHooked.db, attemptsDb: uHooked.db });
    const uQuery = u.withAutoLand(
      u.rawQueryJob(uch.channel, { db: u.h.payout, attemptsDb: u.h.payout }),
    );

    await settle(uTransfer(u.jobOf(d)));
    expect(uHooked.seen()).toBe(true);
    expect(alertCount(u, d, 'unknown_code')).toBe(1);
    expect(await settle(uTransfer(releaseOf(d, 2)))).toEqual({ ok: true });
    expect(await withdrawal(u, d.id)).toMatchObject({
      status: 'PAYING',
      hold_reason: null,
      hold_at: null,
      execute_seq: d.executeSeq,
    });
    const dAttempts = await attempts(u, d.id);
    expect(dAttempts.map((row) => row.kind)).toEqual(['transfer']);
    expect(['pending', 'unknown']).toContain(dAttempts[0]?.result);
    const uRows = await jobs(u);
    expect(queryJobs(uRows)).toEqual([queryJobRow(d, 0, FIRST_QUERY_S)]);
    expect(landJobs(uRows)).toEqual([]);
    expect(pauseJobs(uRows)).toHaveLength(1);
    expect(alertCount(u, d)).toBe(1);
    expect(await changes(u)).toEqual([]);
    expect(uch.transfers()).toEqual([d.outBizNo]);

    // The first query job: the query answers a definite fail → W6 with the refund, no W9.
    await expect(uQuery(u.queryJobOf(d, 0))).resolves.toBeUndefined();
    expect(uch.queries()).toEqual([d.outBizNo]);
    expect(await withdrawal(u, d.id)).toMatchObject({
      status: 'FAILED',
      fail_code: 'TEST_QUERY_FAIL',
      hold_reason: null,
      hold_at: null,
    });
    expect((await changes(u)).filter((data) => data['withdrawal_id'] === d.id)).toEqual([
      expect.objectContaining({ withdrawal_id: d.id, status: 'FAILED' }),
    ]);
    expect(await withdrawalVouchers(u)).toEqual([`wd:${d.id}:FREEZE`, `wd:${d.id}:RETURN`]);
    expect(await balanceOf(u, uOwner)).toEqual({ available_fen: 3_000n, frozen_fen: 0n });
    expect(uch.transfers()).toEqual([d.outBizNo]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-06h#2] 付款方侧失败已识别、completeAttempt 遇瞬时 PG 错误后，release 重投之前该单的查询任务先到（如恢复扫描补投）：查询链也认出付款方异常，即使通道查询返回明确失败也不走 W6、不退回余额、不查询，W9 hold_reason=payer_side_after_transfer、不再排下一个查询点；之后重投的 release 不再转账、不重复留单；对照：同一 app、同一组处理器上转账尝试 pending 且 response 为空但从未识别（进程在 ④ 与完成之间崩溃）的单照常查询，明确失败 W6 退回、成功 W5',
  async () => {
    const f = await querySetup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    // The never-judged controls: PAYING with a transfer attempt pending and response NULL.
    const failOwner = await f.newUser(3_000n);
    const paidOwner = await f.newUser(3_000n);
    const crashedFail = await f.seedPaying(CRASHED_AT, { userId: failOwner, net: 600n }, 'pending');
    const crashedPaid = await f.seedPaying(CRASHED_AT, { userId: paidOwner, net: 600n }, 'pending');
    const order = `CH${crashedPaid.outBizNo}`;
    const ch = scriptedBoth(QUERY_LISTS, {
      [w.outBizNo]: {
        transfer: [PAYER_SIDE_STEP],
        // A query answer query_status_map maps to fail: an ordinary query chain lands W6 (refund).
        query: [QUERY_FAIL_STEP, QUERY_FAIL_STEP, QUERY_FAIL_STEP],
      },
      [crashedFail.outBizNo]: { query: [QUERY_FAIL_STEP] },
      [crashedPaid.outBizNo]: { query: [querySuccess(order)] },
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

    // Before the queue redelivers the release, a query job of point 0 for w is delivered. When
    // the transfer handler landed the hold at once it knew the answer, so the attempt carries the
    // code; otherwise the hold may be the query handler's, which never saw the answer.
    await expect(query(f.queryJobOf(w, 0))).resolves.toBeUndefined();
    await expectPayerSideHeld(f, w, { recorded: landedAtOnce });
    expect(ch.queries()).toEqual([]);
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(await balanceOf(f, owner)).toEqual(balance);

    // The release redelivered afterwards: no transfer, no second hold.
    expect(await settle(transfer(releaseOf(w, 2)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w, { recorded: landedAtOnce });
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(alertCount(f, w)).toBe(1);
    expect(await balanceOf(f, owner)).toEqual(balance);

    // Control, never judged: a release redelivered for it on the same transfer handler only
    // sends the first query (BR-WDR-13 ②: restarted, it sees the pending row and only queries).
    expect(await settle(transfer(releaseOf(crashedFail, 2)))).toEqual({ ok: true });
    expect(await withdrawal(f, crashedFail.id)).toMatchObject({
      status: 'PAYING',
      hold_reason: null,
      hold_at: null,
    });
    expect(queryJobs(jobsOf(await jobs(f), crashedFail))).toEqual([
      queryJobRow(crashedFail, 0, FIRST_QUERY_S),
    ]);
    // Their query jobs on the same query handler: the answers land as on any unknown.
    await expect(query(f.queryJobOf(crashedFail, 0))).resolves.toBeUndefined();
    await expect(query(f.queryJobOf(crashedPaid, 0))).resolves.toBeUndefined();
    expect(ch.queries()).toEqual([crashedFail.outBizNo, crashedPaid.outBizNo]);
    expect(await withdrawal(f, crashedFail.id)).toMatchObject({
      status: 'FAILED',
      fail_code: 'TEST_QUERY_FAIL',
      hold_reason: null,
      hold_at: null,
    });
    expect(await withdrawal(f, crashedPaid.id)).toMatchObject({
      status: 'PAID_API',
      channel_order_id: order,
      hold_reason: null,
      hold_at: null,
    });
    const vouchers = await withdrawalVouchers(f);
    expect(vouchers.filter((key) => key.startsWith(`wd:${crashedFail.id}:`))).toEqual([
      `wd:${crashedFail.id}:FREEZE`,
      `wd:${crashedFail.id}:RETURN`,
    ]);
    expect(vouchers.filter((key) => key.startsWith(`wd:${crashedPaid.id}:`))).toEqual([
      `wd:${crashedPaid.id}:FREEZE`,
      `wd:${crashedPaid.id}:PAID`,
    ]);
    expect(await balanceOf(f, failOwner)).toEqual({ available_fen: 3_000n, frozen_fen: 0n });
    expect(await balanceOf(f, paidOwner)).toEqual({ available_fen: 2_400n, frozen_fen: 0n });
    expect(ch.transfers()).toEqual([w.outBizNo]);
    // The payer-side one is untouched by them.
    await expectPayerSideHeld(f, w, { recorded: landedAtOnce });
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-06h#3] 付款方侧失败已识别后 PG 短暂中断（completeAttempt 与 W9 都失败，release 被拒）：同一进程重投的 release 认出付款方异常，补记尝试 40004 / TEST_PAYER_SIDE 并 W9 hold_reason=payer_side_after_transfer，不发查询、不再转账、不走 W6、不退回余额；之后投到的首个查询也不退回',
  async () => {
    const f = await querySetup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    const ch = scriptedBoth(QUERY_LISTS, {
      [w.outBizNo]: {
        transfer: [PAYER_SIDE_STEP],
        query: [QUERY_FAIL_STEP, QUERY_FAIL_STEP, QUERY_FAIL_STEP],
      },
    });
    const balance = await balanceOf(f, owner);
    const outage = outageFrom(f.h.payout, isAttemptCompletion);
    // One payout process: the same transfer handler for both releases; the query handler apart.
    const transfer = f.rawJob(ch.channel, { db: outage.db, attemptsDb: outage.db });
    const query = f.withAutoLand(
      f.rawQueryJob(ch.channel, { db: f.h.payout, attemptsDb: f.h.payout }),
    );

    const first = await settle(transfer(f.jobOf(w)));
    outage.heal();
    expect(outage.seen()).toBe(true);
    // Nothing of the landing could commit, so the release rejected for the queue to redeliver it.
    expect(first.ok).toBe(false);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAYING',
      hold_reason: null,
      execute_seq: w.executeSeq,
    });
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({ kind: 'transfer', result: 'pending', response: null }),
    ]);
    expect(alertCount(f, w, 'payer_side')).toBe(1);
    expect(queryJobs(jobsOf(await jobs(f), w))).toEqual([]);
    expect(ch.transfers()).toEqual([w.outBizNo]);

    // The queue redelivers the release to the same process, the database healthy again.
    expect(await settle(transfer(releaseOf(w, 2)))).toEqual({ ok: true });
    await expectPayerSideHeld(f, w, { recorded: true });
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(alertCount(f, w)).toBe(1);
    expect(pauseJobs(await jobs(f))).toHaveLength(1);
    expect(await balanceOf(f, owner)).toEqual(balance);

    // A query job of point 0 delivered afterwards (the recovery scan): nothing refunded.
    await expect(query(f.queryJobOf(w, 0))).resolves.toBeUndefined();
    await expectPayerSideHeld(f, w, { recorded: true });
    expect(ch.queries()).toEqual([]);
    expect(ch.transfers()).toEqual([w.outBizNo]);
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

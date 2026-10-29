// B2-07c (规划/08 BR-WDR-23 ① ②, BR-WDR-15): the bill shows a success while ours is PAYING.
// ① needs_manual = false → queried at once through the existing query chain (queue payout, job
//   query, due at once; the payout process's B2-06e handler, the worker lands W5): a success goes
//   W5 (no diff); a result that is not a success — still unknown, or even a definite failure — ends
//   with needs_manual = true (still PAYING, nothing returned), an R2 recon diff and an alert, then
//   BR-WDR-15 (W10). No withdraw hold for ①.
// ② needs_manual = true → only the detail row with the bill line and a pending-disposal hint: no
//   query, no diff, no hold, nothing changed (W10 ends it).
// PAYING without a bill line is still in flight: nothing. Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  QUERY_FAIL_STEP,
  TIMEOUT,
  TRANSFERRED_AT,
  UNKNOWN_STEP,
  alertsAbout,
  allHolds,
  balanceOf,
  books,
  close,
  diffs,
  diffsOf,
  expectDiff,
  expectNoPayeeInLogs,
  lineOf,
  linesAbout,
  open,
  queryJobsOf,
  queryScripted,
  querySuccess,
  rowsOf,
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

it(
  '[AC-B2-07c#13] ① 账单成功、内部 PAYING 且 needs_manual=false：明细 paying_query，立即在 payout 队列投一条现有查询链的 query 任务（不延迟）；查询之前不生成差错单、不冻结、不置 needs_manual',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        date: BILL_DATE,
        bill_date: BILL_DATE,
        channel_order_id: line.channelOrderId,
        our_status: 'PAYING',
        channel_status: 'SUCCESS',
        our_amount_fen: 1_500n,
        channel_amount_fen: 1_500n,
        result: 'paying_query',
      }),
    ]);
    const queued = await queryJobsOf(f, w);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.delay_s).toBe(0);
    expect(queued[0]?.data.payload).toMatchObject({
      app_id: f.appId,
      withdrawal_id: w.id,
      execute_seq: w.executeSeq,
    });
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', needs_manual: false });
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#14] ① 立即查询返回成功：走 W5（PAID_API、channel_order_id、成功分录），不置 needs_manual，不生成差错单、不冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    const channel = queryScripted({ [w.outBizNo]: [querySuccess(line.channelOrderId)] });
    expect(await f.runImmediateQuery(w, channel.channel)).toBe(1);

    expect(channel.queries()).toEqual([w.outBizNo]);
    expect(channel.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAID_API',
      needs_manual: false,
      channel_order_id: line.channelOrderId,
    });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
      `wd:${w.id}:PAID`,
    ]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  ['仍是未知（三次都处理中）', [UNKNOWN_STEP, UNKNOWN_STEP, UNKNOWN_STEP]],
  ['明确失败', [QUERY_FAIL_STEP]],
] as const)(
  '[AC-B2-07c#15] ① 立即查询%s：不是成功 → 置 needs_manual=true（仍 PAYING、不退回、只有冻结分录），生成 R2 差错单（本方 0、账单金额）并告警，之后按 BR-WDR-15；①不冻结会员提现',
  async (_label, steps) => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    const channel = queryScripted({ [w.outBizNo]: steps });
    expect(await f.runImmediateQuery(w, channel.channel)).toBe(1);

    expect(channel.queries().length).toBeGreaterThanOrEqual(1);
    expect(channel.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAYING',
      needs_manual: true,
      fail_code: null,
      paid_at: null,
    });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 3_500n, frozen_fen: 1_500n });
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 0n,
      actualFen: 1_500n,
    });
    expect(alertsAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await allHolds(f)).toEqual([]);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#16] ② 账单成功、内部 PAYING 且 needs_manual=true：只记明细 paying_manual（附账单行）与待处置提示；不查询、不生成差错单、不冻结，提现单不变（由 W10 结束）',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 2_200n });
    await f.markNeedsManual(w);
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        date: BILL_DATE,
        bill_date: BILL_DATE,
        channel_order_id: line.channelOrderId,
        our_status: 'PAYING',
        channel_status: 'SUCCESS',
        channel_amount_fen: 2_200n,
        result: 'paying_manual',
      }),
    ]);
    expect(linesAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await queryJobsOf(f, w)).toEqual([]);
    expect(f.send.mock.calls.filter((call) => call[0] === 'payout')).toEqual([]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#17] 内部 PAYING 而账单没有记录（仍在途）：不是差异——不查询、不生成差错单、不冻结，提现单不变',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 900n });
    f.setBill(BILL_DATE, []);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect((await rowsOf(f, { outBizNo: w.outBizNo })).map((row) => row.result)).not.toContain(
      'diff',
    );
    expect(await queryJobsOf(f, w)).toEqual([]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

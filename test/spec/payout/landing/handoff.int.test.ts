// B2-06fz P→A (D10-326 C; 规划/02 §5.3; 规划/08 BR-WDR-14, BR-WDR-09; state machine W5 / W6): the
// payout process's transfer and query handlers (f.rawJob / f.rawQueryJob: the worker does not
// run) only record a success / fail attempt and enqueue one payout-landing job on the same
// transaction —
//   when the handler returns: the withdrawal is still PAYING (no paid_at, channel_order_id or
//   fail_code), its only voucher is wd:{id}:FREEZE, no wallet.withdrawal_changed, frozen intact;
//   the attempt row carries the result, and its `response` channel_order_id, paid_at (the
//   channel's time) and status (the channel's status before query_status_map); exactly one land
//   job { app_id, withdrawal_id, execute_seq, attempt_id }, key `${id}:${seq}:land:${attempt_id}`;
//   after the worker's turn (landPending): the same W5 / W6 result 06d / 06e pin — status, paid_at,
//   channel_order_id / fail_code, the voucher, balances, the event — and no job left;
//   a redelivery of the payout handler after the landing ends at ① and enqueues no second land
//   job; a redelivery before it does not either (one land job, one voucher).
// Decided on the payout process's side (D10-327 r1): when row_version moved during the channel
// call (or the withdrawal left PAYING / its seq / needs_manual changed), the handler records the
// attempt, warns and enqueues no land job (W10 ends it); a payer-side result is W9 there and is
// never handed to the worker. The transfer attempt's `at` is written before the send; the moment
// the result came back is response.received_at (Clock), which paid_at falls back to.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { FakeStep } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import {
  FAIL_STEP,
  LANDING_QUEUE,
  MINUTE,
  NOW,
  PAYER_SIDE_STEP,
  TIMEOUT,
  attempts,
  balanceOf,
  close,
  entries,
  expectNoPayeeInLogs,
  jobs,
  open,
  scripted,
  setup as processSetup,
  successStep,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type JobRow,
  type ProcessFixture,
} from '../process/kit.ts';
import {
  NOT_FOUND_STEP,
  QUERY_FAIL_STEP,
  RETRY_GAP_MS,
  at,
  jobsOf,
  queryAttempts,
  queryScripted,
  querySuccess,
  setup as querySetup,
} from '../query/kit.ts';
import { CHANNEL_PAID_AT, changesOf, platform, user } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** T + 5 minutes: the query job of point 1. */
const T = at(-5 * MINUTE);

/** The attempt row's `response` as an object ({} when it is not one). */
function responseOf(row: { response: unknown } | undefined): Record<string, unknown> {
  const value = row?.response;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Epoch milliseconds of an ISO instant (NaN when it is not a string). */
function instantOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** How many queue.send calls targeted payout-landing so far. */
function landingSends(f: ProcessFixture): number {
  return f.send.mock.calls.filter((call) => call[0] === LANDING_QUEUE).length;
}

/** The payout-landing job rows of withdrawal `id` (any state). */
function landingRows(rows: readonly JobRow[], id: string): JobRow[] {
  return rows.filter(
    (row) => row.queue === LANDING_QUEUE && row.data.payload['withdrawal_id'] === id,
  );
}

it('[AC-B2-06fz#1] 转账成功（支付宝，含手续费与税）：payout 进程只记尝试并同事务投一条 land 任务——返回时仍 PAYING、只有 FREEZE、无事件；worker 落库后 W5 与 06d 一致（paid_at 取通道时间）；之后重投不再投 land 任务', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(10_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 1000n, fee: 30n, tax: 20n });
  const order = `CH${w.outBizNo}`;
  const ch = scripted({ [w.outBizNo]: [successStep(order, CHANNEL_PAID_AT)] }, { latencyMs: 87 });
  const handler = f.rawJob(ch.channel);
  // Built first: red is the skeleton's NotImplemented.
  f.landingJob();
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  const queued = await f.expectLandingQueued(w);
  expect(await jobs(f)).toEqual([queued.row]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 1050n });
  const recorded = await attempts(f, w.id);
  expect(recorded).toEqual([
    expect.objectContaining({
      id: queued.attemptId,
      kind: 'transfer',
      result: 'success',
      resp_code: '10000',
      resp_sub_code: null,
      latency_ms: 87,
      at: NOW,
    }),
  ]);
  expect(responseOf(recorded[0])).toMatchObject({ channel_order_id: order });
  expect(instantOf(responseOf(recorded[0])['paid_at'])).toBe(Date.parse(CHANNEL_PAID_AT));

  // The worker's turn comes later than the payout process received the success.
  f.clock.advanceMs(MINUTE);
  expect(await f.landPending()).toBe(1);
  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'PAID_API',
    paid_at: new Date(CHANNEL_PAID_AT),
    channel_order_id: order,
    row_version: before.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
    user('frozen', 20n, 'TAX_WITHHOLD'),
    platform('TAX_PAYABLE', -20n, 'TAX_WITHHOLD'),
    user('frozen', 30n, 'WITHDRAW_FEE'),
    platform('FEE_INCOME', -30n, 'WITHDRAW_FEE'),
    user('frozen', 1000n, 'WITHDRAW_PAID'),
    platform('CASH_ALIPAY', -1000n, 'WITHDRAW_PAID'),
  ]);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:PAID`,
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 0n });
  expect(await changesOf(f, w.id)).toEqual([
    expect.objectContaining({ withdrawal_id: w.id, user_id: owner, status: 'PAID_API' }),
  ]);
  expect(await attempts(f, w.id)).toEqual(recorded);
  expect(await jobs(f)).toEqual([]);

  const landed = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w, { attempt: 2 }))).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect(landingSends(f)).toBe(1);
  expect(await jobs(f)).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(landed);
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#2] 转账明确失败（有子码）：payout 进程只记 fail 尝试并投一条 land 任务——返回时仍 PAYING、冻结不动；worker 落库后 W6 → FAILED、fail_code=子码、wd:{id}:RETURN 退回可用、事件；之后重投不再投 land 任务', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const ch = scripted({ [w.outBizNo]: [FAIL_STEP] });
  const handler = f.rawJob(ch.channel);
  f.landingJob();
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  const queued = await f.expectLandingQueued(w);
  expect(await jobs(f)).toEqual([queued.row]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      id: queued.attemptId,
      kind: 'transfer',
      result: 'fail',
      resp_code: '40004',
      resp_sub_code: 'TEST_CONFIRMED_FAIL',
    }),
  ]);

  expect(await f.landPending()).toBe(1);
  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'FAILED',
    fail_code: 'TEST_CONFIRMED_FAIL',
    row_version: before.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(await entries(f, `wd:${w.id}:RETURN`)).toEqual([
    user('frozen', 500n, 'WITHDRAW_RETURN'),
    user('available', -500n, 'WITHDRAW_RETURN'),
  ]);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:RETURN`,
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_000n, frozen_fen: 0n });
  expect(await changesOf(f, w.id)).toEqual([
    expect.objectContaining({ withdrawal_id: w.id, user_id: owner, status: 'FAILED' }),
  ]);
  expect(await jobs(f)).toEqual([]);

  const landed = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w, { attempt: 2 }))).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect(landingSends(f)).toBe(1);
  expect(await jobs(f)).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(landed);
  expect(f.pause).not.toHaveBeenCalled();
});

it('[AC-B2-06fz#6] 转账成功后、worker 落库前同一转账任务被重投：不再转账，land 任务仍只有一条（去重键含 attempt_id）；落库后只有一张 wd:{id}:PAID、一条事件', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 900n });
  const ch = scripted({
    [w.outBizNo]: [successStep(`CH${w.outBizNo}`), successStep(`CH2${w.outBizNo}`)],
  });
  const handler = f.rawJob(ch.channel);
  f.landingJob();
  const job = f.jobOf(w);
  await handler(job);
  const queued = await f.expectLandingQueued(w);
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect(landingRows(await jobs(f), w.id)).toEqual([queued.row]);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');

  expect(await f.landPending()).toBe(1);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    channel_order_id: `CH${w.outBizNo}`,
  });
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:PAID`,
  ]);
  expect(await changesOf(f, w.id)).toHaveLength(1);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_100n, frozen_fen: 0n });
  expect(landingRows(await jobs(f), w.id)).toEqual([]);
});

it('[AC-B2-06fz#7] 转账期间 row_version 被别处改了（payout 进程侧判定）：拿到成功后同事务重读不符 → 只记 success 尝试并 warn，不投 land 任务；单仍 PAYING、只有 FREEZE、冻结不动，留给 W10', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const ch = scripted(
    { [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] },
    {
      before: async () => {
        await sql`UPDATE app.withdrawals SET row_version = row_version + 1
          WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(f.h.observer);
      },
    },
  );
  const handler = f.rawJob(ch.channel);
  // Built first: red is the skeleton's NotImplemented.
  f.landingJob();
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  expect(ch.transfers()).toHaveLength(1);
  expect(landingSends(f)).toBe(0);
  expect(landingRows(await jobs(f), w.id)).toEqual([]);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'success', resp_code: '10000' }),
  ]);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAYING',
    paid_at: null,
    channel_order_id: null,
    fail_code: null,
    row_version: before.row_version + 1,
  });
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
  expect(await changesOf(f, w.id)).toEqual([]);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ withdrawal_id: w.id }),
    expect.any(String),
  );

  expect(await f.landPending()).toBe(0);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#5] 付款方侧失败（payer_side，W9 归 payout 进程）：不投 land 任务；单据回 APPROVED、hold_reason=payer_side_after_transfer（与 06d 一致），冻结不动，尝试记 fail', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 800n });
  const ch = scripted({ [w.outBizNo]: [PAYER_SIDE_STEP] });
  const handler = f.rawJob(ch.channel);
  f.landingJob();
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  expect(ch.transfers()).toHaveLength(1);
  expect(landingSends(f)).toBe(0);
  expect(landingRows(await jobs(f), w.id)).toEqual([]);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'payer_side_after_transfer',
    hold_at: NOW,
    paid_at: null,
    channel_order_id: null,
    fail_code: null,
  });
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      kind: 'transfer',
      result: 'fail',
      resp_code: '40004',
      resp_sub_code: 'TEST_PAYER_SIDE',
    }),
  ]);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_200n, frozen_fen: 800n });

  expect(await f.landPending()).toBe(0);
  expect(f.pause).toHaveBeenCalledTimes(1);
  expect((await withdrawal(f, w.id)).status).toBe('APPROVED');
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#1] 转账成功（银行卡，通道没给到账时间）：尝试行 at 是发出前写入的时刻，收到成功的时刻另记 response.received_at（通道回成功前时钟推进 8 秒）；worker 晚 1 分钟落库，paid_at 取 received_at', async () => {
  const f = await processSetup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 700n, channel: 'bank_card' });
  const order = `CH${w.outBizNo}`;
  const ch = scripted(
    { [w.outBizNo]: [successStep(order)] },
    {
      after: async () => {
        f.clock.advanceMs(8_000);
      },
    },
  );
  const handler = f.rawJob(ch.channel);
  f.landingJob();
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  const queued = await f.expectLandingQueued(w);
  const received = new Date(NOW.getTime() + 8_000);
  const recorded = await attempts(f, w.id);
  expect(recorded).toEqual([
    expect.objectContaining({ id: queued.attemptId, kind: 'transfer', result: 'success', at: NOW }),
  ]);
  expect(responseOf(recorded[0])).toMatchObject({ channel_order_id: order });
  expect(responseOf(recorded[0])['paid_at'] ?? null).toBeNull();
  expect(instantOf(responseOf(recorded[0])['received_at'])).toBe(received.getTime());

  f.clock.advanceMs(MINUTE);
  expect(await f.landPending()).toBe(1);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    paid_at: received,
    channel_order_id: order,
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
    user('frozen', 700n, 'WITHDRAW_PAID'),
    platform('CASH_BANK', -700n, 'WITHDRAW_PAID'),
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 4300n, frozen_fen: 0n });
  expect(await jobs(f)).toEqual([]);
});

it('[AC-B2-06fz#1] 查询成功（支付宝，含手续费与税）：payout 进程只记 success 查询尝试并投一条 land 任务、不投下一时点——返回时仍 PAYING；worker 落库后 W5 与 06e 一致（paid_at 取通道时间）；之后重投不再查询、不再投 land 任务', async () => {
  const f = await querySetup(h);
  const owner = await f.newUser(10_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 1000n, fee: 30n, tax: 20n });
  const order = `CH${w.outBizNo}`;
  const ch = queryScripted({ [w.outBizNo]: [querySuccess(order, CHANNEL_PAID_AT)] });
  const handler = f.rawQueryJob(ch.channel);
  f.landingJob();
  const before = await withdrawal(f, w.id);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();

  const queued = await f.expectLandingQueued(w);
  expect(await jobsOf(f, w.id)).toEqual([queued.row]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 1050n });
  const recorded = await queryAttempts(f, w.id);
  expect(recorded).toEqual([
    expect.objectContaining({
      id: queued.attemptId,
      kind: 'query',
      result: 'success',
      resp_code: '10000',
      resp_sub_code: null,
      request: expect.objectContaining({ out_biz_no: w.outBizNo, point: 1, try: 1 }),
    }),
  ]);
  expect(responseOf(recorded[0])).toMatchObject({ channel_order_id: order });
  expect(instantOf(responseOf(recorded[0])['paid_at'])).toBe(Date.parse(CHANNEL_PAID_AT));

  f.clock.advanceMs(MINUTE);
  expect(await f.landPending()).toBe(1);
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(ch.transfers()).toBe(0);
  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'PAID_API',
    paid_at: new Date(CHANNEL_PAID_AT),
    channel_order_id: order,
    row_version: before.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
    user('frozen', 20n, 'TAX_WITHHOLD'),
    platform('TAX_PAYABLE', -20n, 'TAX_WITHHOLD'),
    user('frozen', 30n, 'WITHDRAW_FEE'),
    platform('FEE_INCOME', -30n, 'WITHDRAW_FEE'),
    user('frozen', 1000n, 'WITHDRAW_PAID'),
    platform('CASH_ALIPAY', -1000n, 'WITHDRAW_PAID'),
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 0n });
  expect(await changesOf(f, w.id)).toEqual([
    expect.objectContaining({ withdrawal_id: w.id, user_id: owner, status: 'PAID_API' }),
  ]);
  expect(await jobsOf(f, w.id)).toEqual([]);

  const landed = await withdrawal(f, w.id);
  await expect(handler(f.queryJobOf(w, 1, { attempt: 2 }))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(landingSends(f)).toBe(1);
  expect(await jobsOf(f, w.id)).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(landed);
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#1] 查询第 2 次才成功（银行卡，通道没给到账时间）：land 任务指向那条 success 尝试，尝试行 at 为收到成功时的时钟（等待推进 10 秒）；worker 晚 1 分钟落库，paid_at 仍取该 at，两条分录', async () => {
  const f = await querySetup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 700n, channel: 'bank_card' });
  const order = `CH${w.outBizNo}`;
  const ch = queryScripted({ [w.outBizNo]: [NOT_FOUND_STEP, querySuccess(order)] });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
    f.clock.advanceMs(RETRY_GAP_MS);
  });
  const handler = f.rawQueryJob(ch.channel, { sleep });
  f.landingJob();
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();

  const queued = await f.expectLandingQueued(w);
  expect(await jobsOf(f, w.id)).toEqual([queued.row]);
  const received = new Date(NOW.getTime() + RETRY_GAP_MS);
  expect(await queryAttempts(f, w.id)).toEqual([
    expect.objectContaining({ result: 'unknown' }),
    expect.objectContaining({ id: queued.attemptId, result: 'success', at: received }),
  ]);

  f.clock.advanceMs(MINUTE);
  expect(await f.landPending()).toBe(1);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    paid_at: received,
    channel_order_id: order,
    needs_manual: false,
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
    user('frozen', 700n, 'WITHDRAW_PAID'),
    platform('CASH_BANK', -700n, 'WITHDRAW_PAID'),
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 4300n, frozen_fen: 0n });
  expect(await jobsOf(f, w.id)).toEqual([]);
});

/** A status query_status_map maps to fail, with no sub code: fail_code is that status. */
const QUERY_FAIL_NO_SUB_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '10000' },
  status: 'TEST_CLOSED',
};

it.each([
  ['有子码', QUERY_FAIL_STEP, 'TEST_QUERY_FAIL', 'TEST_QUERY_FAIL'],
  ['无子码、只有映射前的状态', QUERY_FAIL_NO_SUB_STEP, null, 'TEST_CLOSED'],
] as const)(
  '[AC-B2-06fz#3] 查询明确失败（%s）：payout 进程只记 fail 查询尝试（response 带映射前的通道状态）并投一条 land 任务——返回时仍 PAYING；worker 落库后 W6 → FAILED、fail_code 与 06e 一致、退回冻结、事件；之后重投不再查询',
  async (_label, step, subCode, failCode) => {
    const f = await querySetup(h);
    const owner = await f.newUser(2_000n);
    const w = await f.seedPaying(T, { userId: owner, net: 500n });
    const ch = queryScripted({ [w.outBizNo]: [step] });
    const handler = f.rawQueryJob(ch.channel);
    f.landingJob();
    const before = await withdrawal(f, w.id);
    await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();

    const queued = await f.expectLandingQueued(w);
    expect(await jobsOf(f, w.id)).toEqual([queued.row]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
    const recorded = await queryAttempts(f, w.id);
    expect(recorded).toEqual([
      expect.objectContaining({
        id: queued.attemptId,
        kind: 'query',
        result: 'fail',
        resp_code: '10000',
        resp_sub_code: subCode,
      }),
    ]);
    expect(responseOf(recorded[0])).toMatchObject({ status: 'TEST_CLOSED' });

    expect(await f.landPending()).toBe(1);
    expect(await withdrawal(f, w.id)).toEqual({
      ...before,
      status: 'FAILED',
      fail_code: failCode,
      row_version: before.row_version + 1,
      updated_at: expect.any(Date),
    });
    expect(await entries(f, `wd:${w.id}:RETURN`)).toEqual([
      user('frozen', 500n, 'WITHDRAW_RETURN'),
      user('available', -500n, 'WITHDRAW_RETURN'),
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_000n, frozen_fen: 0n });
    expect(await changesOf(f, w.id)).toEqual([
      expect.objectContaining({ withdrawal_id: w.id, status: 'FAILED' }),
    ]);
    expect(await jobsOf(f, w.id)).toEqual([]);

    await expect(handler(f.queryJobOf(w, 1, { attempt: 2 }))).resolves.toBeUndefined();
    expect(ch.queries()).toEqual([w.outBizNo]);
    expect(landingSends(f)).toBe(1);
    expect(await jobsOf(f, w.id)).toEqual([]);
    expect(f.pause).not.toHaveBeenCalled();
  },
);

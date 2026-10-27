// B2-06fz ③ (D10-326 C; 规划/08 BR-WDR-14, BR-WDR-09; state machine W5 / W6): the worker lands
// the attempt a payout-landing job names —
//   success  W5 → PAID_API: channel_order_id from the attempt's response, paid_at the channel's
//            time (response.paid_at) else the attempt's `at` (when the payout process received
//            the success, not when the worker lands it); WITHDRAW:SUCCESS:CASH_<channel>
//            `wd:{id}:PAID` (zero fee / tax lines omitted); frozen cleared; the event;
//   fail     W6 → FAILED: fail_code = resp_sub_code, else response.status, else resp_code;
//            WITHDRAW:RETURN `wd:{id}:RETURN` (frozen back to available); the event.
// The attempt row itself is the payout process's record: the worker never changes it.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CHANNEL_PAID_AT,
  MINUTE,
  RECEIVED_AT,
  TIMEOUT,
  attempts,
  balanceOf,
  changesOf,
  close,
  entries,
  expectNoPayeeInLogs,
  jobs,
  landJobOf,
  open,
  platform,
  seedResult,
  seedSuccess,
  seedTransferFail,
  setup,
  user,
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

it('[AC-B2-06fz#1] 转账成功的尝试（支付宝，含手续费与税）：W5 → PAID_API，通道单号取尝试行，paid_at 取通道给的到账时间，wd:{id}:PAID 六条分录，冻结清零、可用不变，事件；尝试行不变、不投任务', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const owner = await f.newUser(10_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 1000n, fee: 30n, tax: 20n });
  const order = `CH${w.outBizNo}`;
  const attemptId = await seedSuccess(f, w, { channelOrderId: order, paidAt: CHANNEL_PAID_AT });
  const before = await withdrawal(f, w.id);
  const recorded = await attempts(f, w.id);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 1050n });

  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();

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
  expectNoPayeeInLogs(f);
});

it.each(['transfer', 'query'] as const)(
  '[AC-B2-06fz#1] %s 成功的尝试（银行卡，手续费与税为 0）、通道没给到账时间：paid_at 取该尝试行的 at（收到成功的服务器时间），不取 worker 落库时的时钟；两条分录（冻结 → CASH_BANK）',
  async (kind) => {
    const f = await setup(h);
    const handler = f.landingJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 700n, channel: 'bank_card' });
    const order = `CH${w.outBizNo}`;
    const attemptId = await seedSuccess(f, w, { channelOrderId: order, kind });
    // The worker runs later than the payout process received the success.
    f.clock.advanceMs(5 * MINUTE);
    await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAID_API',
      paid_at: RECEIVED_AT,
      channel_order_id: order,
      fail_code: null,
    });
    expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
      user('frozen', 700n, 'WITHDRAW_PAID'),
      platform('CASH_BANK', -700n, 'WITHDRAW_PAID'),
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 4300n, frozen_fen: 0n });
    expect(await changesOf(f, w.id)).toEqual([
      expect.objectContaining({ withdrawal_id: w.id, status: 'PAID_API' }),
    ]);
  },
);

it('[AC-B2-06fz#2] 转账明确失败的尝试（有子码）：W6 → FAILED，fail_code=resp_sub_code，wd:{id}:RETURN 冻结退回可用，事件；尝试行不变', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const attemptId = await seedTransferFail(f, w);
  const before = await withdrawal(f, w.id);
  const recorded = await attempts(f, w.id);
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
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
  expect(await attempts(f, w.id)).toEqual(recorded);
  expect(await jobs(f)).toEqual([]);
  expectNoPayeeInLogs(f);
});

/** [label, resp_sub_code, response.status, resp_code, the fail_code W6 writes]. */
type FailCodeCase = readonly [string, string | null, string | null, string, string];

const FAIL_CODES: readonly FailCodeCase[] = [
  ['有子码：子码优先于状态', 'TEST_QUERY_FAIL', 'TEST_CLOSED', '10000', 'TEST_QUERY_FAIL'],
  [
    '无子码、有映射前的状态：取状态（不取网关成功码 10000）',
    null,
    'TEST_CLOSED',
    '10000',
    'TEST_CLOSED',
  ],
  ['子码与状态都没有：取 resp_code', null, null, 'TEST_FAIL_CODE', 'TEST_FAIL_CODE'],
];

it.each(FAIL_CODES)(
  '[AC-B2-06fz#3] 查询明确失败的尝试（%s）：W6 → FAILED 且 fail_code 按 resp_sub_code → response.status → resp_code 取值，退回冻结',
  async (_label, subCode, status, code, failCode) => {
    const f = await setup(h);
    const handler = f.landingJob();
    const owner = await f.newUser(2_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 600n });
    const attemptId = await seedResult(f, w, {
      kind: 'query',
      result: 'fail',
      respCode: code,
      respSubCode: subCode,
      response: {
        raw: subCode === null ? { code } : { code, subCode },
        kind: 'fail',
        ...(status === null ? {} : { status }),
      },
    });
    await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'FAILED',
      fail_code: failCode,
      paid_at: null,
      channel_order_id: null,
    });
    expect(await entries(f, `wd:${w.id}:RETURN`)).toEqual([
      user('frozen', 600n, 'WITHDRAW_RETURN'),
      user('available', -600n, 'WITHDRAW_RETURN'),
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_000n, frozen_fen: 0n });
    expect(await changesOf(f, w.id)).toEqual([
      expect.objectContaining({ withdrawal_id: w.id, status: 'FAILED' }),
    ]);
  },
);

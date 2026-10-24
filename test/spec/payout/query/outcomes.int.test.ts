// B2-06e ④ ⑦ (规划/08 BR-WDR-14, BR-WDR-17, BR-WDR-28, BR-WDR-09; state machine W5 / W6): a query
// result the channel judges with payout.query_status_map lands like the transfer's —
//   success  W5 → PAID_API, channel_order_id, paid_at (the channel's time when given, else the
//            Clock), one voucher wd:{id}:PAID (frozen → CASH_<channel>, zero fee / tax lines
//            omitted), frozen cleared, wallet.withdrawal_changed, no further query job;
//   fail     W6 → FAILED, fail_code = sub code, wd:{id}:RETURN (frozen → available), event;
// each try is one kind=query attempt; the channel's transfer is never called. A CAS that hits
// nothing (row_version moved during the query) only warns. payout.enabled = off and
// payout.queue_paused = true do not stop queries or their landing (the switches gate sending).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MINUTE,
  NOW,
  TIMEOUT,
  UNKNOWN_STEP,
  QUERY_FAIL_STEP,
  at,
  attempts,
  balanceOf,
  changes,
  close,
  configOf,
  entries,
  expectNoPayeeInLogs,
  jobsOf,
  open,
  platform,
  queryAttempts,
  queryJobRow,
  queryScripted,
  querySuccess,
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

const CHANNEL_PAID_AT = '2026-10-19T10:00:07+08:00';
/** T + 5 minutes: the job of point 1. */
const T = at(-5 * MINUTE);

it('[AC-B2-06e#4] 查询成功（支付宝，含手续费与税）：W5 → PAID_API，记通道单号与通道到账时间，wd:{id}:PAID 六条分录，冻结清零，事件，一行 query 尝试，不再投任务', async () => {
  const f = await setup(h);
  const owner = await f.newUser(10_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 1000n, fee: 30n, tax: 20n });
  const order = `CH${w.outBizNo}`;
  const ch = queryScripted({ [w.outBizNo]: [querySuccess(order, CHANNEL_PAID_AT)] });
  const handler = f.queryJob(ch.channel);
  const before = await withdrawal(f, w.id);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 1050n });
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();

  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(ch.transfers()).toBe(0);
  expect(f.sleep).not.toHaveBeenCalled();
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
  expect(await queryAttempts(f, w.id)).toEqual([
    expect.objectContaining({
      kind: 'query',
      result: 'success',
      resp_code: '10000',
      resp_sub_code: null,
      request: expect.objectContaining({ out_biz_no: w.outBizNo, point: 1, try: 1 }),
    }),
  ]);
  const [row] = await queryAttempts(f, w.id);
  expect(row?.response).not.toBeNull();
  expect(row?.latency_ms).toEqual(expect.any(Number));
  expect(row?.latency_ms).toBeGreaterThanOrEqual(0);
  expect(await attempts(f, w.id)).toHaveLength(2);
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, user_id: owner, status: 'PAID_API' }),
  );
  expect(await jobsOf(f, w.id)).toEqual([]);
  expect(f.pause).not.toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06e#4] 查询成功（银行卡，手续费与税为 0）：两条分录（冻结 → CASH_BANK），通道没给到账时间时 paid_at 取注入时钟', async () => {
  const f = await setup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 700n, channel: 'bank_card' });
  const order = `CH${w.outBizNo}`;
  const ch = queryScripted({ [w.outBizNo]: [querySuccess(order)] });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    paid_at: NOW,
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

it('[AC-B2-06e#4] 查询返回 query_status_map 映射为 fail 的状态：W6 → FAILED，fail_code=子码，wd:{id}:RETURN 冻结退回可用，尝试记 fail，事件，不再投任务', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 500n });
  const ch = queryScripted({ [w.outBizNo]: [QUERY_FAIL_STEP] });
  const handler = f.queryJob(ch.channel);
  const before = await withdrawal(f, w.id);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(ch.transfers()).toBe(0);
  expect(f.sleep).not.toHaveBeenCalled();
  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'FAILED',
    fail_code: 'TEST_QUERY_FAIL',
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
  expect(await queryAttempts(f, w.id)).toEqual([
    expect.objectContaining({
      kind: 'query',
      result: 'fail',
      resp_code: '10000',
      resp_sub_code: 'TEST_QUERY_FAIL',
      request: expect.objectContaining({ out_biz_no: w.outBizNo, point: 1, try: 1 }),
    }),
  ]);
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, status: 'FAILED' }),
  );
  expect(await jobsOf(f, w.id)).toEqual([]);
  expect(f.pause).not.toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06e#4] 成功落库时 CAS 落空（查询期间 row_version 被改）：不迁移、不写凭证、不抛错，记 warn', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(T, { userId: owner, net: 500n });
  const ch = queryScripted(
    { [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] },
    {
      before: async () => {
        await sql`UPDATE app.withdrawals SET row_version = row_version + 1
          WHERE id = ${w.id}`.execute(f.h.observer);
      },
    },
  );
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
  expect(f.logger.warn).toHaveBeenCalled();
});

it.each([
  ['payout.enabled=off', { enabled: false, paused: false }],
  ['payout.queue_paused=true', { enabled: true, paused: true }],
  ['两个开关同时关', { enabled: false, paused: true }],
] as const)(
  '[AC-B2-06e#7] %s 时查询照常：成功照样 W5 落库记账，开关不变',
  async (_label, switches) => {
    const f = await setup(h);
    await f.set('payout.enabled', switches.enabled);
    await f.set('payout.queue_paused', switches.paused);
    const owner = await f.newUser(3_000n);
    const w = await f.seedPaying(T, { userId: owner, net: 900n });
    const ch = queryScripted({ [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] });
    const handler = f.queryJob(ch.channel);
    await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
    expect(ch.queries()).toEqual([w.outBizNo]);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAID_API',
      channel_order_id: `CH${w.outBizNo}`,
    });
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_100n, frozen_fen: 0n });
    expect(await configOf(f, 'payout.enabled')).toBe(switches.enabled);
    expect(await configOf(f, 'payout.queue_paused')).toBe(switches.paused);
  },
);

it('[AC-B2-06e#7] payout.enabled=off 且 queue_paused=true 时三次都未知：照样查满 3 次并投下一时点任务', async () => {
  const f = await setup(h);
  await f.set('payout.enabled', false);
  await f.set('payout.queue_paused', true);
  const w = await f.seedPaying(T);
  const ch = queryScripted({ [w.outBizNo]: [UNKNOWN_STEP, UNKNOWN_STEP, UNKNOWN_STEP] });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(3);
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 2, 25 * 60)]);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
});

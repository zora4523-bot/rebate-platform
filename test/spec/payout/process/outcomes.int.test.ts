// B2-06d ⑥ (规划/08 BR-WDR-14, BR-WDR-17, BR-WDR-28, BR-WDR-09; state machine W5 / W6 / W9 / W7;
// 规划/12 §5.4 "alt" branches): the synchronous result as B2-06b's FakeChannel judges it —
//   success     W5 → PAID_API, channel_order_id, paid_at (the channel's time when given, else the
//               Clock), one voucher wd:{id}:PAID (frozen → CASH_<channel>, zero fee / tax lines
//               omitted), attempt success;
//   definite    W6 → FAILED, fail_code = sub_code, voucher wd:{id}:RETURN (frozen → available),
//               attempt fail;
//   payer side  W9 hold_reason payer_side_after_transfer, frozen kept, payout.queue_paused set
//               and alerted, attempt fail;
//   unlisted    stays PAYING, attempt unknown, queue paused and alerted, first query job;
//   transport   (no script, timeout, rejection, 10000 without SUCCESS) stays PAYING, attempt
//               unknown, no pause, first query job; the job still resolves (no queue retry).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import {
  ALERT,
  DEALING_STEP,
  EXECUTED_AT,
  FAIL_STEP,
  NOW,
  PAYER_SIDE_STEP,
  TIMEOUT,
  TIMEOUT_STEP,
  UNKNOWN_STEP,
  UNLISTED_STEP,
  attempts,
  balanceOf,
  changes,
  close,
  configOf,
  entries,
  expectNoPayeeInLogs,
  expectQueryJob,
  jobs,
  negativeJobs,
  open,
  queryJobs,
  scripted,
  setup,
  successStep,
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

const CHANNEL_PAID_AT = '2026-10-19T10:00:05+08:00';

/** A member entry (USER_BALANCE; debit positive, credit negative). */
function user(sub: 'available' | 'frozen', amount: bigint, type: string) {
  return {
    owner_type: 'user',
    subject: 'USER_BALANCE',
    sub_account: sub,
    amount_fen: amount,
    ledger_type: type,
  };
}

/** A platform entry (stored on the available sub-account). */
function platform(subject: string, amount: bigint, type: string) {
  return {
    owner_type: 'platform',
    subject,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: type,
  };
}

it('[AC-B2-06d#6] 成功（支付宝，含手续费与税）：W5 → PAID_API，记通道单号与通道到账时间，一张 wd:{id}:PAID 凭证六条分录，冻结清零、可用不变', async () => {
  const f = await setup(h);
  const owner = await f.newUser(10_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 1000n, fee: 30n, tax: 20n });
  const order = `CH${w.outBizNo}`;
  const ch = scripted({ [w.outBizNo]: [successStep(order, CHANNEL_PAID_AT)] }, { latencyMs: 87 });
  const handler = f.job(ch.channel);
  const before = await withdrawal(f, w.id);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 8950n, frozen_fen: 1050n });
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();

  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'PAID_API',
    paid_at: new Date(CHANNEL_PAID_AT),
    channel_order_id: order,
    row_version: before.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(before).toMatchObject({ executed_at: EXECUTED_AT, hold_reason: null, fail_code: null });
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
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      kind: 'transfer',
      result: 'success',
      resp_code: '10000',
      resp_sub_code: null,
      latency_ms: 87,
    }),
  ]);
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, user_id: owner, status: 'PAID_API' }),
  );
  expect(await jobs(f)).toEqual([]);
  expect(await configOf(f, 'payout.queue_paused')).toBe(false);
  expect(f.pause).not.toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06d#6] 成功（银行卡，手续费与税为 0）：凭证只有两条分录（冻结 → CASH_BANK），通道没给到账时间时 paid_at 取注入时钟', async () => {
  const f = await setup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 700n, channel: 'bank_card' });
  const order = `CH${w.outBizNo}`;
  const ch = scripted({ [w.outBizNo]: [successStep(order)] });
  const handler = f.job(ch.channel);
  await handler(f.jobOf(w));
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    paid_at: NOW,
    channel_order_id: order,
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([
    user('frozen', 700n, 'WITHDRAW_PAID'),
    platform('CASH_BANK', -700n, 'WITHDRAW_PAID'),
  ]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 4300n, frozen_fen: 0n });
});

it('[AC-B2-06d#6] 明确失败（definite_fail_codes 内）：W6 → FAILED，fail_code=子码，wd:{id}:RETURN 冻结退回可用，尝试记 fail', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const ch = scripted({ [w.outBizNo]: [FAIL_STEP] });
  const handler = f.job(ch.channel);
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
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
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      result: 'fail',
      resp_code: '40004',
      resp_sub_code: 'TEST_CONFIRMED_FAIL',
    }),
  ]);
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, status: 'FAILED' }),
  );
  expect(await jobs(f)).toEqual([]);
  expect(f.pause).not.toHaveBeenCalled();
});

it('[AC-B2-06d#6] 付款方侧失败（payer_side_codes 内）：W9 hold_reason=payer_side_after_transfer，不退余额，尝试记 fail，置 payout.queue_paused 并告警', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 800n });
  const ch = scripted({ [w.outBizNo]: [PAYER_SIDE_STEP] });
  const handler = f.job(ch.channel);
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(await withdrawal(f, w.id)).toEqual({
    ...before,
    status: 'APPROVED',
    hold_reason: 'payer_side_after_transfer',
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
    row_version: before.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(before).toMatchObject({ batch_id: w.batchId, execute_seq: 1 });
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_200n, frozen_fen: 800n });
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      result: 'fail',
      resp_code: '40004',
      resp_sub_code: 'TEST_PAYER_SIDE',
    }),
  ]);
  expect(await configOf(f, 'payout.queue_paused')).toBe(true);
  expect(f.pause).toHaveBeenCalledTimes(1);
  const [trx, input] = f.pause.mock.calls[0]!;
  expect(trx.isTransaction).toBe(true);
  expect(input).toMatchObject({ appId: f.appId });
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ withdrawal_id: w.id, cause: 'payer_side' }),
    ALERT,
  );
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, status: 'APPROVED' }),
  );
  const queued = await jobs(f);
  expect(queryJobs(queued)).toEqual([]);
  expect(negativeJobs(queued)).toEqual([]);
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06d#6] 清单外的业务码：按结果未知处理——保持 PAYING、尝试记 unknown，同时置 payout.queue_paused 并告警，投递首个查询任务', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 600n });
  const ch = scripted({ [w.outBizNo]: [UNLISTED_STEP] });
  const handler = f.job(ch.channel);
  const before = await withdrawal(f, w.id);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAYING',
    execute_seq: before.execute_seq,
    executor_id: before.executor_id,
    executed_at: before.executed_at,
    hold_reason: null,
    needs_manual: false,
    paid_at: null,
    fail_code: null,
  });
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_400n, frozen_fen: 600n });
  expect(await attempts(f, w.id)).toEqual([
    expect.objectContaining({
      result: 'unknown',
      resp_code: '40004',
      resp_sub_code: 'TEST_NOT_IN_ANY_LIST',
    }),
  ]);
  expect(await configOf(f, 'payout.queue_paused')).toBe(true);
  expect(f.pause).toHaveBeenCalledTimes(1);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ withdrawal_id: w.id, cause: 'unknown_code' }),
    ALERT,
  );
  expectQueryJob(await jobs(f), w);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  const changed = (await changes(f)).filter((payload) => JSON.stringify(payload).includes(w.id));
  expect(changed).toEqual([]);
});

/** A channel whose transfer rejects with a network error (no judgement at all). */
function rejecting(): { channel: PayoutChannel; calls: () => number } {
  let count = 0;
  return {
    channel: {
      async transfer() {
        count += 1;
        throw new Error('ECONNRESET');
      },
      async query() {
        return { kind: 'unknown', raw: { code: 'UNUSED' } };
      },
    },
    calls: () => count,
  };
}

it.each([
  ['通道没有可说的结果（unknown）', UNKNOWN_STEP],
  ['10 秒超时（TimeoutError）', TIMEOUT_STEP],
  ['10000 但状态不是 SUCCESS', DEALING_STEP],
] as const)(
  '[AC-B2-06d#6] 传输类或处理中（%s）：保持 PAYING、尝试记 unknown，不暂停队列，投递首个查询任务，任务正常结束不抛错',
  async (_label, step) => {
    const f = await setup(h);
    const owner = await f.newUser(2_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 600n });
    const ch = scripted({ [w.outBizNo]: [step] });
    const handler = f.job(ch.channel);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    expect(ch.transfers()).toHaveLength(1);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAYING',
      hold_reason: null,
      needs_manual: false,
    });
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_400n, frozen_fen: 600n });
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
    ]);
    expect(await configOf(f, 'payout.queue_paused')).toBe(false);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalledWith(expect.anything(), ALERT);
    expectQueryJob(await jobs(f), w);
  },
);

it('[AC-B2-06d#6] 通道调用抛出网络错误：同样按未知处理，不重试转账、不抛错、投递首个查询任务', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 600n });
  const broken = rejecting();
  const handler = f.job(broken.channel);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(broken.calls()).toBe(1);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
  expect(await attempts(f, w.id)).toEqual([expect.objectContaining({ result: 'unknown' })]);
  expect(await configOf(f, 'payout.queue_paused')).toBe(false);
  expectQueryJob(await jobs(f), w);
});

it('[AC-B2-06d#6] 成功落库时 CAS 落空（转账期间 row_version 被改）：不写凭证、不重试、不抛错，记 warn', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const ch = scripted(
    { [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] },
    {
      before: async () => {
        await sql`UPDATE app.withdrawals SET row_version = row_version + 1
          WHERE id = ${w.id}`.execute(f.h.observer);
      },
    },
  );
  const handler = f.job(ch.channel);
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(ch.transfers()).toHaveLength(1);
  expect((await withdrawal(f, w.id)).status).toBe('PAYING');
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
  expect(f.logger.warn).toHaveBeenCalled();
});

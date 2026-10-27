// B2-06fz (D10-326 C; 规划/08 BR-WDR-14, BR-WDR-09; 规划/02 §18 CAS and lock order; at-least-once
// delivery, AGENTS.md rule 5):
//   ⑥ a redelivered landing job, or a second landing job of the same withdrawal (a transfer
//      success, then a query success or fail), stops at ① once the withdrawal left PAYING: one
//      voucher, one event, the first result's columns;
//   ⑦ a CAS that hits nothing (row_version moved after the landing read the withdrawal) writes
//      nothing — no transition, no voucher, no event — warns and resolves;
//   ⑧ lock order users → withdrawal: identity's lockUsersForUpdate is called before anything
//      locks or updates the withdrawal row;
//   ⑨ logs never carry the payee's account or name.
// The queue path (send on payout-landing, the worker's turn through landPending) is pinned too.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  CHANNEL_PAID_AT,
  LANDING_JOB,
  LANDING_QUEUE,
  RECEIVED_AT,
  TIMEOUT,
  balanceOf,
  bumpRowVersion,
  changesOf,
  close,
  entries,
  expectNoPayeeInLogs,
  jobs,
  landJobOf,
  open,
  seedResult,
  seedSuccess,
  seedTransferFail,
  setup,
  snapshot,
  withdrawal,
  withdrawalRowFree,
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

it('[AC-B2-06fz#6] 同一落库任务被重投：第二次在 ① 结束（已不是 PAYING），只记一次账、一条事件，单据不变', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const owner = await f.newUser(3_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 900n });
  const attemptId = await seedSuccess(f, w, { paidAt: CHANNEL_PAID_AT });
  const job = landJobOf(w, attemptId);
  await expect(handler(job)).resolves.toBeUndefined();
  const landed = await snapshot(f);
  expect((await withdrawal(f, w.id)).status).toBe('PAID_API');
  await expect(handler({ ...job, attempt: 2 })).resolves.toBeUndefined();
  await expect(handler({ ...job, attempt: 3 })).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(landed);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:PAID`,
  ]);
  expect(await changesOf(f, w.id)).toHaveLength(1);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_100n, frozen_fen: 0n });
});

it.each([
  ['又来查询成功（另一通道单号）', 'success'],
  ['又来查询明确失败', 'fail'],
] as const)(
  '[AC-B2-06fz#6] 两条落库任务：转账成功先落库，%s：后一条在 ① 结束——只有一张 wd:{id}:PAID、没有 RETURN、单号与到账时间是先到那条的',
  async (_label, second) => {
    const f = await setup(h);
    const handler = f.landingJob();
    const owner = await f.newUser(3_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    const transferId = await seedSuccess(f, w, {
      channelOrderId: `CH${w.outBizNo}`,
      paidAt: CHANNEL_PAID_AT,
    });
    const queryId =
      second === 'success'
        ? await seedSuccess(f, w, { channelOrderId: `CH2${w.outBizNo}`, kind: 'query' })
        : await seedResult(f, w, {
            kind: 'query',
            result: 'fail',
            respCode: '10000',
            respSubCode: 'TEST_QUERY_FAIL',
            response: { raw: { code: '10000', subCode: 'TEST_QUERY_FAIL' }, kind: 'fail' },
          });
    await expect(handler(landJobOf(w, transferId))).resolves.toBeUndefined();
    const landed = await snapshot(f);
    await expect(handler(landJobOf(w, queryId))).resolves.toBeUndefined();
    expect(await snapshot(f)).toEqual(landed);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAID_API',
      channel_order_id: `CH${w.outBizNo}`,
      paid_at: new Date(CHANNEL_PAID_AT),
      fail_code: null,
    });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
      `wd:${w.id}:PAID`,
    ]);
    expect(await changesOf(f, w.id)).toEqual([
      expect.objectContaining({ withdrawal_id: w.id, status: 'PAID_API' }),
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_200n, frozen_fen: 0n });
  },
);

it('[AC-B2-06fz#6] 经 payout-landing 队列：同一去重键（含 attempt_id）投两次只留一条任务，worker 执行一次即落库，之后再轮一次无事可做', async () => {
  const f = await setup(h);
  // Built first: red is the skeleton's NotImplemented.
  f.landingJob();
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const attemptId = await seedSuccess(f, w);
  const key = `${w.id}:${w.executeSeq}:land:${attemptId}`;
  const payload = {
    app_id: w.appId,
    withdrawal_id: w.id,
    execute_seq: w.executeSeq,
    attempt_id: attemptId,
  };
  for (let round = 0; round < 2; round += 1) {
    await f.h.setup.runtime.send(LANDING_QUEUE, LANDING_JOB, payload, {
      trx: null,
      singletonKey: key,
    });
  }
  expect(await jobs(f)).toEqual([
    {
      queue: LANDING_QUEUE,
      singleton_key: key,
      state: 'created',
      data: { name: LANDING_JOB, payload },
      delay_s: 0,
    },
  ]);
  expect(await f.landPending()).toBe(1);
  expect(await f.landPending()).toBe(0);
  expect((await withdrawal(f, w.id)).status).toBe('PAID_API');
  expect(await entries(f, `wd:${w.id}:PAID`)).toHaveLength(2);
  // landPending deletes the rows it ran (test SQL): nothing is left for the worker.
  expect(await jobs(f)).toEqual([]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 0n });
});

it.each(['success', 'fail'] as const)(
  '[AC-B2-06fz#7] 落库时 CAS 落空（读单之后 row_version 被别处改了，%s）：改成了 → 不迁移、不记账、无事件、不抛错，只记 warn；没改成（行已被落库事务锁住）→ 正常落库',
  async (result) => {
    const f = await setup(h);
    const owner = await f.newUser(2_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 500n });
    const attemptId = result === 'success' ? await seedSuccess(f, w) : await seedTransferFail(f, w);
    // Another writer tries to move row_version once the landing holds the balance lock, before
    // its CAS. Both shapes are accepted (D10-327 r1 S2): when the landing already holds the
    // withdrawal row the bump does nothing (bumped = false) and the landing goes through.
    let tried = false;
    let bumped = false;
    const ledger: Ledger = {
      ...f.ledger,
      async lockBalances(trx, input) {
        if (!tried) {
          tried = true;
          bumped = await bumpRowVersion(f, w);
        }
        return f.ledger.lockBalances(trx, input);
      },
    };
    const handler = f.landingJob({ ledger });
    const before = await withdrawal(f, w.id);
    await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
    expect(tried).toBe(true);
    const vouchers = (await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`));
    if (bumped) {
      expect(await withdrawal(f, w.id)).toEqual({
        ...before,
        row_version: before.row_version + 1,
      });
      expect(vouchers).toEqual([`wd:${w.id}:FREEZE`]);
      expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
      expect(await changesOf(f, w.id)).toEqual([]);
      expect(f.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ withdrawal_id: w.id }),
        expect.any(String),
      );
    } else if (result === 'success') {
      expect(await withdrawal(f, w.id)).toMatchObject({
        status: 'PAID_API',
        channel_order_id: `CH${w.outBizNo}`,
        paid_at: RECEIVED_AT,
        row_version: before.row_version + 1,
      });
      expect(vouchers).toEqual([`wd:${w.id}:FREEZE`, `wd:${w.id}:PAID`]);
      expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 0n });
      expect(await changesOf(f, w.id)).toEqual([
        expect.objectContaining({ withdrawal_id: w.id, status: 'PAID_API' }),
      ]);
    } else {
      expect(await withdrawal(f, w.id)).toMatchObject({
        status: 'FAILED',
        fail_code: 'TEST_CONFIRMED_FAIL',
        row_version: before.row_version + 1,
      });
      expect(vouchers).toEqual([`wd:${w.id}:FREEZE`, `wd:${w.id}:RETURN`]);
      expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_000n, frozen_fen: 0n });
      expect(await changesOf(f, w.id)).toEqual([
        expect.objectContaining({ withdrawal_id: w.id, status: 'FAILED' }),
      ]);
    }
    expectNoPayeeInLogs(f);
  },
);

it('[AC-B2-06fz#8] 锁序 users → 提现单：每次调用 lockUsersForUpdate 时提现单行都没有被任何人锁住或改动（行锁与 UPDATE 都在其后），参数为本单的 app 与会员，在事务里调用', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 500n });
  const attemptId = await seedSuccess(f, w);
  const before = await withdrawal(f, w.id);
  const seen: { free: boolean; status: string; version: number }[] = [];
  const lock = vi.fn(
    async (
      trx: Transaction<DB>,
      input: { readonly appId: string; readonly userIds: readonly string[] },
    ) => {
      const row = await withdrawal(f, w.id);
      seen.push({
        free: await withdrawalRowFree(f, w),
        status: row.status,
        version: row.row_version,
      });
      return lockUsersForUpdate(trx, input);
    },
  );
  const handler = f.landingJob({ lockUsersForUpdate: lock });
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
  expect(lock).toHaveBeenCalled();
  for (const call of lock.mock.calls) {
    expect(call[0].isTransaction).toBe(true);
    expect(call[1]).toEqual({ appId: w.appId, userIds: [owner] });
  }
  expect(seen[0]).toEqual({ free: true, status: 'PAYING', version: before.row_version });
  expect(seen.every((each) => each.free)).toBe(true);
  expect((await withdrawal(f, w.id)).status).toBe('PAID_API');
});

it('[AC-B2-06fz#9] 日志只有 id 与码：成功、失败、重投在 ① 结束、尝试未知在 ② 结束各走一遍，任何一行都不含收款账号或姓名', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const paid = await f.seedWithdrawal();
  const failed = await f.seedWithdrawal();
  const unknown = await f.seedWithdrawal();
  const success = await seedSuccess(f, paid);
  const fail = await seedTransferFail(f, failed);
  const pending = await seedResult(f, unknown, { result: 'unknown', respCode: '20000' });
  await handler(landJobOf(paid, success));
  await handler(landJobOf(failed, fail));
  await handler(landJobOf(paid, success, { attempt: 2 }));
  await handler(landJobOf(unknown, pending));
  expect(f.logger.warn).toHaveBeenCalled();
  expect(f.logger.info).toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

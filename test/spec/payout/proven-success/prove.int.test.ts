// B2-07e W11 rule tests, the proven path (claude-independent, SPEC_REF 37808a50): 规划/08 BR-WDR-08
// W11 (APPROVED → PAID_API on the channel's proof; paid_at the bill line's time when it has one,
// else the server's time; channel_order_id from the bill line; the payer-side hold cleared; the
// operator recorded as the executor), BR-WDR-09 (WITHDRAW:SUCCESS:CASH_ALIPAY `wd:{id}:PAID`, one
// voucher, zero lines dropped, against frozen), BR-WDR-07 (lock order users → balances), task
// §9.2 (operator admin:<id>; the attempt-append job queued on the same transaction;
// wallet.withdrawal_changed) and the frozen invariant before and after. The guard counts only
// kind=transfer (query rows after the failed transfer do not stop W11); a withdrawal changed by
// another transaction while W11 waits on the users row → 20902 resource=withdrawal (CAS).
// W11's port runs on a real PostgreSQL (kit.ts); the job queue records its sends.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ATTEMPT_QUEUE,
  BOOKED_AT_MS,
  NOW,
  PAYEE_NAME,
  SWITCH,
  TIMEOUT,
  appendSends,
  attemptRows,
  balanceOf,
  changes,
  channelOrderOf,
  close,
  entries,
  frozenMismatches,
  lockUsersRow,
  lockWaited,
  open,
  paidEntries,
  rejectWithdrawal,
  setup,
  voucherOf,
  watch,
  withdrawalRow,
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
  '[AC-B2-07e#1] W11 凭账单行核销：开关缺省（未配置）即 on；APPROVED 且 payer_side_after_transfer、唯一转账尝试 fail、账单行含该 out_biz_no 且金额 = net_fen → PAID_API：paid_at 取账单行入账时间、channel_order_id 取账单行、hold_reason / hold_at 清空、executor_id 为操作人、executed_at 为服务端时间、row_version + 1，其余列不变；返回 proven 与这三个值',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed({ net: 1000n, fee: 30n, tax: 20n });
    const before = await withdrawalRow(h.observer, f.appId, w.id);
    const attemptsBefore = await attemptRows(h.observer, f.appId, w.id);

    const result = await f.prove(f.input(w), port);

    expect(result).toEqual({
      kind: 'proven',
      status: 'PAID_API',
      paidAt: new Date(BOOKED_AT_MS),
      channelOrderId: channelOrderOf(w),
    });
    expect(await withdrawalRow(h.observer, f.appId, w.id)).toEqual({
      ...before,
      status: 'PAID_API',
      paid_at: new Date(BOOKED_AT_MS),
      channel_order_id: channelOrderOf(w),
      hold_reason: null,
      hold_at: null,
      executor_id: f.operatorId,
      executed_at: new Date(NOW),
      row_version: before.row_version + 1,
      updated_at: new Date(NOW),
    });
    // W11 itself writes no attempt: the payout process appends it from the queued job.
    expect(await attemptRows(h.observer, f.appId, w.id)).toEqual(attemptsBefore);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#2] W11 的分录（BR-WDR-09）：同一事务记 WITHDRAW:SUCCESS:CASH_ALIPAY 凭证 wd:{id}:PAID 恰一张（net / fee / tax 三种流水自 frozen 出，零额行不写），operator admin:<操作人>；available 不变、frozen 减去整笔金额；冻结不变量前后都成立',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed({ net: 1000n, fee: 30n, tax: 20n });
    const bare = await f.seed({ net: 800n });
    expect(await frozenMismatches(h.observer, f.appId)).toEqual([]);
    const balance = await balanceOf(h.observer, f.ledger, f.appId, f.userId);

    await f.prove(f.input(w), port);
    await f.prove(f.input(bare), port);

    expect((await withdrawalVouchers(h.observer, f.appId)).sort()).toEqual(
      [`wd:${w.id}:FREEZE`, `wd:${w.id}:PAID`, `wd:${bare.id}:FREEZE`, `wd:${bare.id}:PAID`].sort(),
    );
    expect(await entries(h.observer, f.appId, `wd:${w.id}:PAID`)).toEqual(paidEntries(w));
    expect(await entries(h.observer, f.appId, `wd:${bare.id}:PAID`)).toEqual(paidEntries(bare));
    expect(await voucherOf(h.observer, f.appId, `wd:${w.id}:PAID`)).toEqual([
      {
        uniq_key: `wd:${w.id}:PAID`,
        biz_type: 'withdrawal',
        biz_id: w.id,
        operator: `admin:${f.operatorId}`,
      },
    ]);
    expect(await balanceOf(h.observer, f.ledger, f.appId, f.userId)).toEqual({
      available_fen: balance.available_fen,
      frozen_fen: balance.frozen_fen - w.amount - bare.amount,
    });
    expect(await frozenMismatches(h.observer, f.appId)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#3] 同一事务发 wallet.withdrawal_changed（PAID_API）恰一次，并在同一事务把 attempt-append 任务入队 payout-attempt-append 恰一条（载荷含 app_id、withdrawal_id、recon_diff_id；不含收款人信息）',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    const request = f.input(w);

    await f.prove(request, port);

    expect(await changes(h.observer, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: w.userId, status: 'PAID_API' },
    ]);
    const sends = appendSends(f);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(ATTEMPT_QUEUE);
    expect(sends[0]!.payload).toMatchObject({
      app_id: f.appId,
      withdrawal_id: w.id,
      recon_diff_id: request.reconDiffId,
    });
    const options = sends[0]!.options as { trx?: { isTransaction?: boolean } | null };
    expect(options.trx?.isTransaction, '入队必须带核销的事务').toBe(true);
    expect(JSON.stringify(sends[0]!.payload)).not.toContain(PAYEE_NAME);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#4] 账单行没有入账时间 → paid_at 取服务端当前时间；账单行没有渠道单号 → channel_order_id 为 null；开关显式为 true 时同样放行',
  async () => {
    const f = await setup(h);
    await f.set(SWITCH, true);
    const port = f.port();
    const w = await f.seed();

    const result = await f.prove(
      f.input(w, { billLine: { bookedAt: null, channelOrderId: null } }),
      port,
    );

    expect(result).toEqual({
      kind: 'proven',
      status: 'PAID_API',
      paidAt: new Date(NOW),
      channelOrderId: null,
    });
    expect(await withdrawalRow(h.observer, f.appId, w.id)).toMatchObject({
      status: 'PAID_API',
      paid_at: new Date(NOW),
      channel_order_id: null,
      hold_reason: null,
      hold_at: null,
    });
    expect((await withdrawalVouchers(h.observer, f.appId)).sort()).toEqual(
      [`wd:${w.id}:FREEZE`, `wd:${w.id}:PAID`].sort(),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#5] 同一笔核销后再来一次（同一差错单或别的差错单）：单已是 PAID_API → 20902 resource=withdrawal，不再记第二张凭证、不再发事件、不再入队',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    const first = f.input(w);
    await f.prove(first, port);
    const after = await f.snapshot();
    const sendCount = f.sent.length;

    for (const request of [first, f.input(w)]) {
      let caught: unknown;
      try {
        await f.prove(request, port);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 20902, data: { resource: 'withdrawal' } });
    }

    expect(await f.snapshot()).toEqual(after);
    expect(f.sent).toHaveLength(sendCount);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#36] CAS（双连接、确定性）：W11 在会员 users 行锁上等待时，持锁事务把该单 APPROVED → REJECTED（row_version + 1）后提交；W11 放行后抛 20902 resource=withdrawal——不记 wd:{id}:PAID、不发钱包事件、不入队 attempt-append，单保持持锁事务写下的样子，尝试记录与余额不变',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    const row = await withdrawalRow(h.observer, f.appId, w.id);
    const before = await f.snapshot();

    const lock = await lockUsersRow(h.observer, f.appId, w.userId);
    const call = watch(f.prove(f.input(w), port));
    try {
      expect(await lockWaited(h.observer, call), 'W11 应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release((trx) => rejectWithdrawal(trx, f.appId, w.id, f.clock.now()));
    }
    const outcome = await call.outcome;

    expect(outcome.ok, 'W11 must throw the withdrawal conflict').toBe(false);
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: 20902,
      data: { resource: 'withdrawal' },
    });
    expect(await withdrawalRow(h.observer, f.appId, w.id)).toEqual({
      ...row,
      status: 'REJECTED',
      reject_reason_code: 'OTHER',
      row_version: row.row_version + 1,
      updated_at: new Date(NOW),
    });
    const after = await f.snapshot();
    expect({ ...after, withdrawals: [] }).toEqual({ ...before, withdrawals: [] });
    expect(after.vouchers).not.toContain(`wd:${w.id}:PAID`);
    expect(await changes(h.observer, f.appId)).toEqual([]);
    expect(appendSends(f)).toEqual([]);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#38] 转账失败之后还有查询记录（query unknown、query fail）：守卫只数 kind=transfer，照常 PAID_API、记 wd:{id}:PAID 一张、入队 attempt-append；既有的转账与查询记录原样不动',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const seeds = [
      await f.seed({
        attempts: [
          ['transfer', 'fail'],
          ['query', 'unknown'],
        ],
      }),
      await f.seed({
        net: 1000n,
        fee: 30n,
        tax: 20n,
        attempts: [
          ['transfer', 'fail'],
          ['query', 'fail'],
        ],
      }),
    ];
    expect(await frozenMismatches(h.observer, f.appId)).toEqual([]);

    for (const w of seeds) {
      const attemptsBefore = await attemptRows(h.observer, f.appId, w.id);
      expect(attemptsBefore.map((attempt) => attempt.kind).sort()).toEqual(['query', 'transfer']);

      expect(await f.prove(f.input(w), port)).toEqual({
        kind: 'proven',
        status: 'PAID_API',
        paidAt: new Date(BOOKED_AT_MS),
        channelOrderId: channelOrderOf(w),
      });

      expect(await withdrawalRow(h.observer, f.appId, w.id)).toMatchObject({
        status: 'PAID_API',
        paid_at: new Date(BOOKED_AT_MS),
        channel_order_id: channelOrderOf(w),
        hold_reason: null,
        hold_at: null,
        executor_id: f.operatorId,
      });
      expect(await entries(h.observer, f.appId, `wd:${w.id}:PAID`)).toEqual(paidEntries(w));
      expect(await attemptRows(h.observer, f.appId, w.id)).toEqual(attemptsBefore);
    }

    expect((await withdrawalVouchers(h.observer, f.appId)).sort()).toEqual(
      seeds.flatMap((w) => [`wd:${w.id}:FREEZE`, `wd:${w.id}:PAID`]).sort(),
    );
    expect(appendSends(f).map((item) => item.payload['withdrawal_id'])).toEqual(
      seeds.map((w) => w.id),
    );
    expect(await frozenMismatches(h.observer, f.appId)).toEqual([]);
  },
  TIMEOUT,
);

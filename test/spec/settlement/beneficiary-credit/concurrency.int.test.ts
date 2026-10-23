// B2-04q rule tests on a real PostgreSQL: the lock flow of BR-FUND-16 细则「加锁流程」 (order_key
// advisory → users row through the BeneficiaryGate → balance rows → states re-read after the locks),
// state changes racing the item, two executions of one order, and atomicity (voucher and obligation
// close in one transaction). Waits are observed on the server (pg_blocking_pids), never slept on.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  TIMEOUT,
  bounded,
  creditKey,
  databaseFixture,
  deferred,
  failAfter,
  forfeitKey,
  harness,
  tracing,
  userLines,
  waitBlocked,
  type Harness,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function lockUserRow(trx: Kysely<DB>, h: Harness, userId: string): Promise<void> {
  await trx
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', h.appId)
    .where('id', '=', userId)
    .forUpdate()
    .execute();
}

it(
  '[AC-B2-04q#26] 加锁流程：advisory(order_key) → users 行（经 BeneficiaryGate / identity）→ 余额行 → 锁后重读状态 → 记账 → 关闭义务；订单与义务在 advisory 之后重读，全部用调用方事务',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const direct = o.user('direct');
    const traced = tracing(p.db);
    expect(await h.execute(o, { via: traced.db })).toMatchObject({ outcome: 'credited' });

    expect(h.lockUsers.mock.calls[0]?.[1]).toMatchObject({ appId: h.appId });
    expect(h.lockUsers.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining([direct]));
    expect(h.identityLock).toHaveBeenCalled();
    expect(h.lockBalances.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining([direct]));
    expect(h.readStates.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining([direct]));

    const firstUsers = Math.min(...h.lockUsers.mock.invocationCallOrder);
    const firstBalances = Math.min(...h.lockBalances.mock.invocationCallOrder);
    const lastBalances = Math.max(...h.lockBalances.mock.invocationCallOrder);
    const firstStates = Math.min(...h.readStates.mock.invocationCallOrder);
    const firstPost = Math.min(...h.post.mock.invocationCallOrder);
    expect(firstUsers).toBeLessThan(firstBalances);
    expect(firstBalances).toBeLessThan(firstStates);
    expect(lastBalances).toBeLessThan(firstPost);
    expect(firstStates).toBeLessThan(firstPost);
    expect(h.post).toHaveBeenCalledTimes(1);

    const statements = traced.queries.map((q) => q.sql);
    const advisory = statements.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    const usersLock = statements.findIndex(
      (s) => /from\s+(?:"app"\.)?"users"/i.test(s) && /for no key update/i.test(s),
    );
    const orderReread = statements.findIndex(
      (s, i) => i > advisory && /from\s+(?:"app"\.)?"orders"/i.test(s),
    );
    const obligationReread = statements.findIndex(
      (s, i) => i > advisory && /from\s+(?:"app"\.)?"beneficiary_credits"/i.test(s),
    );
    const firstVoucher = statements.findIndex((s) =>
      /insert\s+into\s+(?:"app"\.)?"ledger_vouchers"/i.test(s),
    );
    const obligationClose = statements.findIndex((s) =>
      /update\s+(?:"app"\.)?"beneficiary_credits"/i.test(s),
    );
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(orderReread).toBeGreaterThan(advisory);
    expect(obligationReread).toBeGreaterThan(advisory);
    expect(usersLock).toBeGreaterThan(advisory);
    expect(firstVoucher).toBeGreaterThan(usersLock);
    expect(obligationClose).toBeGreaterThan(firstVoucher);

    const trx = h.transactions[0];
    for (const call of [
      ...h.lockUsers.mock.calls,
      ...h.lockBalances.mock.calls,
      ...h.readStates.mock.calls,
      ...h.post.mock.calls,
      ...h.readOrderNets.mock.calls,
      ...h.readSnapshot.mock.calls,
    ]) {
      expect(call[0]).toBe(trx);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#27] 先解冻后执行：解冻事务持 users 行并改为 normal，补记在 users 行锁上等待，提交后锁内重读为 normal → 补记 85',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const direct = o.user('direct');
    h.boot();
    const locked = deferred();
    const commit = deferred();
    let holderPid = 0;
    const holder = p.left.transaction().execute(async (trx) => {
      holderPid = await bounded(trx);
      await lockUserRow(trx, h, direct);
      await h.setRisk(trx, direct, 'normal');
      locked.resolve();
      await commit.promise;
    });
    let result: unknown;
    try {
      await locked.promise;
      let itemPid = 0;
      const started = deferred();
      const run = h.execute(o, {
        via: p.right,
        onPid: (pid) => {
          itemPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, itemPid, holderPid);
      commit.resolve();
      await holder;
      result = await run;
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(result).toMatchObject({ outcome: 'credited', amountFen: 85n });
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userLines(o, 'direct', 85n));
    expect(await h.balance(direct)).toBe(85n);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'done',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#28] 先封禁后执行：封禁事务持 users 行未提交，补记等待；提交后锁内重读为 banned → 首次整份没收（FORFEIT 85），不入账',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const direct = o.user('direct');
    h.boot();
    const locked = deferred();
    const commit = deferred();
    let holderPid = 0;
    const holder = p.left.transaction().execute(async (trx) => {
      holderPid = await bounded(trx);
      await lockUserRow(trx, h, direct);
      await h.setRisk(trx, direct, 'banned');
      locked.resolve();
      await commit.promise;
    });
    let result: unknown;
    try {
      await locked.promise;
      let itemPid = 0;
      const started = deferred();
      const run = h.execute(o, {
        via: p.right,
        onPid: (pid) => {
          itemPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, itemPid, holderPid);
      commit.resolve();
      await holder;
      result = await run;
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(result).toMatchObject({ outcome: 'forfeited', forfeitReason: 'banned', amountFen: 85n });
    expect(await h.voucherKeys()).toContain(forfeitKey(o, 'direct'));
    expect(await h.voucherKeys()).not.toContain(creditKey(o, 'direct'));
    expect(await h.balance(direct)).toBe(0n);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: direct, status: 'forfeited', reason: 'banned' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#29] 先执行后冻结：补记持 users 行锁时冻结事务等待；补记按执行时的正常状态入账，冻结在其后生效',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const direct = o.user('direct');
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let itemPid = 0;
    const run = h.execute(o, {
      via: p.left,
      onPid: (pid) => {
        itemPid = pid;
      },
    });
    let freezer: Promise<void> | undefined;
    let result: unknown;
    try {
      await paused.promise;
      let freezerPid = 0;
      const started = deferred();
      freezer = p.right.transaction().execute(async (trx) => {
        freezerPid = await bounded(trx);
        started.resolve();
        await lockUserRow(trx, h, direct);
        await h.setRisk(trx, direct, 'frozen');
      });
      await started.promise;
      await waitBlocked(p.control, freezerPid, itemPid);
      release.resolve();
      result = await run;
      await freezer;
    } finally {
      release.resolve();
      await run.catch(() => undefined);
      await freezer?.catch(() => undefined);
    }
    expect(result).toMatchObject({ outcome: 'credited', amountFen: 85n });
    expect(await h.balance(direct)).toBe(85n);
    const risk = await p.db
      .selectFrom('user_risk_state')
      .select('state')
      .where('app_id', '=', h.appId)
      .where('user_id', '=', direct)
      .executeTakeFirst();
    expect(risk?.state).toBe('frozen');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#30] 先登记维权后执行：维权事务持 order_key advisory 锁并置 rights_pending，补记在同键上等待；提交后锁内重读 → 跳过（rights_pending），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.state();
    h.boot();
    const locked = deferred();
    const commit = deferred();
    let holderPid = 0;
    const holder = p.left.transaction().execute(async (trx) => {
      holderPid = await bounded(trx);
      await lockOrderKey(trx, o.platform, o.subOrderId);
      await trx
        .updateTable('orders')
        .set({ rights_pending: true })
        .where('app_id', '=', h.appId)
        .where('order_id', '=', o.orderId)
        .execute();
      locked.resolve();
      await commit.promise;
    });
    let result: unknown;
    try {
      await locked.promise;
      let itemPid = 0;
      const started = deferred();
      const run = h.execute(o, {
        via: p.right,
        onPid: (pid) => {
          itemPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, itemPid, holderPid);
      commit.resolve();
      await holder;
      result = await run;
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(result).toEqual({ outcome: 'skipped', reason: 'rights_pending' });
    const after = await h.state();
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.balances).toEqual(before.balances);
    expect(after.obligations).toEqual(before.obligations);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#31] 同一义务两连接并发（同一义务被两个批次纳入）：第二个在 order_key 锁上等待，第一个提交后锁内重读义务已完成 → 跳过；凭证与余额只一份',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let firstPid = 0;
    const first = h.execute(o, {
      via: p.left,
      onPid: (pid) => {
        firstPid = pid;
      },
    });
    let second: Promise<unknown> | undefined;
    const results: unknown[] = [];
    try {
      await paused.promise;
      let secondPid = 0;
      const started = deferred();
      second = h.execute(o, {
        via: p.right,
        input: { closedRef: 'batch-item-second' },
        onPid: (pid) => {
          secondPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, secondPid, firstPid);
      release.resolve();
      results.push(await first, await second);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
    }
    expect(results).toEqual([
      expect.objectContaining({ outcome: 'credited', amountFen: 85n }),
      { outcome: 'skipped', reason: 'obligation_closed' },
    ]);
    expect((await h.voucherKeys()).filter((k) => k === creditKey(o, 'direct'))).toHaveLength(1);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'done',
      closed_ref: h.input(o).closedRef,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#32] 同单两个义务（直推、间推）并发执行：按 order_key 串行，后者锁内重算 ⑤ 后照常补记；两笔都到账，应收 = booked_n',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ held: ['direct', 'indirect'] });
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let firstPid = 0;
    const first = h.execute(o, {
      via: p.left,
      role: 'direct',
      onPid: (pid) => {
        firstPid = pid;
      },
    });
    let second: Promise<unknown> | undefined;
    const results: unknown[] = [];
    try {
      await paused.promise;
      let secondPid = 0;
      const started = deferred();
      second = h.execute(o, {
        via: p.right,
        role: 'indirect',
        onPid: (pid) => {
          secondPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, secondPid, firstPid);
      release.resolve();
      results.push(await first, await second);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
    }
    expect(results).toEqual([
      expect.objectContaining({ outcome: 'credited', role: 'direct', amountFen: 85n }),
      expect.objectContaining({ outcome: 'credited', role: 'indirect', amountFen: 42n }),
    ]);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect(h.alerts()).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  { name: '关闭义务的 UPDATE', pattern: /update\s+(?:"app"\.)?"beneficiary_credits"/i },
  { name: '写凭证的 INSERT', pattern: /insert\s+into\s+(?:"app"\.)?"ledger_vouchers"/i },
])(
  '[AC-B2-04q#33] 原子性：$name 执行后失败，整个事务回滚——无凭证、余额不变、义务仍 open',
  async ({ pattern }) => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.state();
    const faulty = failAfter(p.db, (q) => pattern.test(q.sql));
    h.boot();
    await expect(h.execute(o, { via: faulty.db })).rejects.toThrow(
      'injected failure after the statement ran',
    );
    expect(faulty.injected()).toBe(1);
    expect(await h.state()).toEqual(before);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'open',
      voucher_id: null,
    });
    expect(await h.balance(o.user('direct'))).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#34] 回滚后重试：同一义务在失败回滚后再执行，补记一次成功，凭证只一张',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const faulty = failAfter(p.db, (q) =>
      /update\s+(?:"app"\.)?"beneficiary_credits"/i.test(q.sql),
    );
    h.boot();
    await expect(h.execute(o, { via: faulty.db })).rejects.toThrow(
      'injected failure after the statement ran',
    );
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 85n });
    expect((await h.voucherKeys()).filter((k) => k === creditKey(o, 'direct'))).toHaveLength(1);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'done',
    });
  },
  TIMEOUT,
);

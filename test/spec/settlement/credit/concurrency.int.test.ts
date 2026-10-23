// B2-04m rule tests on a real PostgreSQL: the lock flow of BR-FUND-16 细则「加锁流程」.
// Two connections and a barrier, both orders each time; a wait is observed on the server
// (pg_blocking_pids), never inferred from a sleep. "A state change wins" means the transaction that
// changes a beneficiary's state locks the users row first (BR-FUND-16: such transactions must).
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
  forfeitKey,
  harness,
  platformKey,
  receivable,
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

async function riskOf(h: Harness, userId: string): Promise<string | undefined> {
  const row = await p.db
    .selectFrom('user_risk_state')
    .select('state')
    .where('app_id', '=', h.appId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.state;
}

it(
  '[AC-B2-04m#27] 先冻结后入账：冻结事务持有 users 行并改状态，入账在 users 行锁上等待，提交后锁内重读为 frozen → 直推暂缓、开义务',
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
      await h.setRisk(trx, direct, 'frozen');
      locked.resolve();
      await commit.promise;
    });
    try {
      await locked.promise;
      let creditPid = 0;
      const started = deferred();
      const credit = h.credit(o, {
        via: p.right,
        onPid: (pid) => {
          creditPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, creditPid, holderPid);
      commit.resolve();
      await holder;
      expect(await credit).toMatchObject({ outcome: 'credited' });
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(await h.voucherKeys()).toEqual(
      [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
    );
    expect(await h.balance(direct)).toBe(0n);
    expect(await h.obligations()).toEqual([
      expect.objectContaining({
        user_id: direct,
        role: 'direct',
        kind: 'first_credit',
        status: 'open',
      }),
    ]);
    expect(await h.subjectNet(receivable(o))).toBe(915n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#28] 先入账后冻结：入账持有 users 行锁时冻结事务等待；入账按入账时的正常状态记账，冻结在其后生效',
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
    let creditPid = 0;
    const credit = h.credit(o, {
      via: p.left,
      onPid: (pid) => {
        creditPid = pid;
      },
    });
    let freezer: Promise<void> | undefined;
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
      await waitBlocked(p.control, freezerPid, creditPid);
      release.resolve();
      expect(await credit).toMatchObject({ outcome: 'credited' });
      await freezer;
    } finally {
      release.resolve();
      await credit.catch(() => undefined);
      await freezer?.catch(() => undefined);
    }
    expect(await h.balance(direct)).toBe(85n);
    expect(await h.obligations()).toEqual([]);
    expect(await riskOf(h, direct)).toBe('frozen');
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#29] 先注销后入账：注销事务把 users.status 改为 deleting 未提交，入账等待；提交后锁内重读 → 直推份额归平台（deleted）',
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
      await trx
        .updateTable('users')
        .set({ status: 'deleting' })
        .where('app_id', '=', h.appId)
        .where('id', '=', direct)
        .execute();
      locked.resolve();
      await commit.promise;
    });
    try {
      await locked.promise;
      let creditPid = 0;
      const started = deferred();
      const credit = h.credit(o, {
        via: p.right,
        onPid: (pid) => {
          creditPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, creditPid, holderPid);
      commit.resolve();
      await holder;
      expect(await credit).toMatchObject({ outcome: 'credited' });
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'indirect'),
        platformKey(o),
        forfeitKey(o, 'direct'),
      ].sort(),
    );
    expect(await h.balance(direct)).toBe(0n);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: direct, status: 'forfeited', reason: 'deleted' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#30] 先入账后注销：入账持锁时注销事务等待；入账照常给直推入账，注销在其后生效',
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
    let creditPid = 0;
    const credit = h.credit(o, {
      via: p.left,
      onPid: (pid) => {
        creditPid = pid;
      },
    });
    let deleter: Promise<unknown> | undefined;
    try {
      await paused.promise;
      let deleterPid = 0;
      const started = deferred();
      deleter = p.right.transaction().execute(async (trx) => {
        deleterPid = await bounded(trx);
        started.resolve();
        return trx
          .updateTable('users')
          .set({ status: 'deleting' })
          .where('app_id', '=', h.appId)
          .where('id', '=', direct)
          .execute();
      });
      await started.promise;
      await waitBlocked(p.control, deleterPid, creditPid);
      release.resolve();
      expect(await credit).toMatchObject({ outcome: 'credited' });
      await deleter;
    } finally {
      release.resolve();
      await credit.catch(() => undefined);
      await deleter?.catch(() => undefined);
    }
    expect(await h.balance(direct)).toBe(85n);
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#31] 先 hold 后入账：hold 事务持 order_key advisory 锁（orders.lockOrderKey 同键），入账等待；提交后锁内重读 hold → 跳过，什么都不写',
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
        .set({ hold: true, hold_reason: 'CS', row_version: 1 })
        .where('app_id', '=', h.appId)
        .where('order_id', '=', o.orderId)
        .execute();
      locked.resolve();
      await commit.promise;
    });
    let result: unknown;
    try {
      await locked.promise;
      let creditPid = 0;
      const started = deferred();
      const credit = h.credit(o, {
        via: p.right,
        onPid: (pid) => {
          creditPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, creditPid, holderPid);
      commit.resolve();
      await holder;
      result = await credit;
    } finally {
      commit.resolve();
      await holder.catch(() => undefined);
    }
    expect(result).toEqual({ outcome: 'skipped', reason: 'hold' });
    const after = await h.state();
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.balances).toEqual(before.balances);
    expect(after.obligations).toEqual([]);
    expect(after.events).toEqual([]);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', hold: true });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#32] 先入账后 hold：入账持 order_key 锁时 hold 事务在同键上等待，拿到锁后看到 CREDITED',
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
    let creditPid = 0;
    const credit = h.credit(o, {
      via: p.left,
      onPid: (pid) => {
        creditPid = pid;
      },
    });
    let seen: string | undefined;
    let other: Promise<void> | undefined;
    try {
      await paused.promise;
      let otherPid = 0;
      const started = deferred();
      other = p.right.transaction().execute(async (trx) => {
        otherPid = await bounded(trx);
        started.resolve();
        await lockOrderKey(trx, o.platform, o.subOrderId);
        const row = await trx
          .selectFrom('orders')
          .select('rebate_status')
          .where('app_id', '=', h.appId)
          .where('order_id', '=', o.orderId)
          .executeTakeFirstOrThrow();
        seen = row.rebate_status;
      });
      await started.promise;
      await waitBlocked(p.control, otherPid, creditPid);
      release.resolve();
      expect(await credit).toMatchObject({ outcome: 'credited' });
      await other;
    } finally {
      release.resolve();
      await credit.catch(() => undefined);
      await other?.catch(() => undefined);
    }
    expect(seen).toBe('CREDITED');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#33] 同一子订单两连接重放：第二个在 order_key 锁上等待，第一个提交后锁内重读为 CREDITED → 跳过；凭证与余额只一份',
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
    const first = h.credit(o, {
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
      second = h.credit(o, {
        via: p.right,
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
      expect.objectContaining({ outcome: 'credited' }),
      { outcome: 'skipped', reason: 'not_waiting' },
    ]);
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect((await h.published()).map((e) => e.name)).toEqual(['order.credited']);
    expect(await h.history(o)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#34] 交叉受益人（X：U1 本人 / U2 直推；Y：U2 本人 / U1 直推）并发入账：按 user_id 升序加锁，Y 等待 X 而不死锁，两单都入账',
  async () => {
    const h = await harness(p.db);
    const u1 = await h.user();
    const u2 = await h.user();
    const x = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, userId: u1 },
        { role: 'direct', ratioBp: 1000, userId: u2 },
      ],
    });
    const y = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, userId: u2 },
        { role: 'direct', ratioBp: 1000, userId: u1 },
      ],
    });
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let xPid = 0;
    const creditX = h.credit(x, {
      via: p.left,
      onPid: (pid) => {
        xPid = pid;
      },
    });
    let creditY: Promise<unknown> | undefined;
    const results: unknown[] = [];
    try {
      await paused.promise;
      let yPid = 0;
      const started = deferred();
      creditY = h.credit(y, {
        via: p.right,
        onPid: (pid) => {
          yPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, yPid, xPid);
      release.resolve();
      results.push(await creditX, await creditY);
    } finally {
      release.resolve();
      await creditX.catch(() => undefined);
      await creditY?.catch(() => undefined);
    }
    expect(results).toEqual([
      expect.objectContaining({ outcome: 'credited' }),
      expect.objectContaining({ outcome: 'credited' }),
    ]);
    expect(await h.balance(u1)).toBe(510n);
    expect(await h.balance(u2)).toBe(510n);
  },
  TIMEOUT,
);

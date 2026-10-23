// B2-04s rule tests on a real PostgreSQL: the B2-04m lock flow reused by the clawback (BR-FUND-01
// order_key advisory lock; BR-FUND-16 细则「加锁流程」: order_key → users rows → balance rows, then
// the beneficiary states re-read). Waits are observed with pg_blocking_pids, never inferred from
// a sleep.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { lockOrderKey, orderLockKeyText } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  TIMEOUT,
  badDebtLines,
  bounded,
  clawbackKey,
  databaseFixture,
  deferred,
  harness,
  tracing,
  userClawbackLines,
  waitBlocked,
  type CommandSpec,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const FULL: CommandSpec = { cause: 'INVALID_AFTER_SETTLE', ref: { kind: 'platform' } };

it(
  '[AC-B2-04s#37] 加锁顺序：先取 order_key advisory 锁（orders.lockOrderKey 同键），再锁受益人 users 行，再锁余额行，锁后重读受益人状态',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.boot();
    h.lockUsers.mockClear();
    h.lockBalances.mockClear();
    h.readStates.mockClear();
    const traced = tracing(p.db);

    expect(await h.apply(o, FULL, { via: traced.db })).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
    });

    const advisory = traced.queries.findIndex(
      (q) =>
        q.sql.includes('pg_advisory_xact_lock') &&
        q.parameters.includes(orderLockKeyText(o.platform, o.subOrderId)),
    );
    const usersLock = traced.queries.findIndex(
      (q) => /"users"/.test(q.sql) && /for update/i.test(q.sql),
    );
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(usersLock).toBeGreaterThan(advisory);

    const [users] = h.lockUsers.mock.invocationCallOrder;
    const [balances] = h.lockBalances.mock.invocationCallOrder;
    const [states] = h.readStates.mock.invocationCallOrder;
    expect(users).toBeDefined();
    expect(balances).toBeGreaterThan(users ?? Number.MAX_SAFE_INTEGER);
    expect(states).toBeGreaterThan(balances ?? Number.MAX_SAFE_INTEGER);
    const lockedIds = h.lockUsers.mock.calls[0]?.[1].userIds ?? [];
    expect([...lockedIds].sort()).toEqual(o.people.map((person) => person.userId).sort());
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#38] 扣回等待 order_key 锁：持锁事务在锁内把直推标为注销 processing 后提交，扣回拿到锁后重读状态 → 直推的扣回改记 BAD_DEBT，余额不动',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.boot();
    const direct = o.user('direct');
    const locked = deferred();
    const release = deferred();
    const holderPid = deferred<number>();
    const clawPid = deferred<number>();

    const holder = p.left.transaction().execute(async (trx) => {
      holderPid.resolve(await bounded(trx));
      await lockOrderKey(trx, o.platform, o.subOrderId);
      locked.resolve();
      await release.promise;
      await trx
        .updateTable('users')
        .set({ status: 'deleting' })
        .where('app_id', '=', h.appId)
        .where('id', '=', direct)
        .execute();
    });
    await locked.promise;
    const claw = h.apply(o, FULL, { via: p.right, onPid: (pid) => clawPid.resolve(pid) });
    await waitBlocked(p.control, await clawPid.promise, await holderPid.promise);
    release.resolve();
    await holder;

    const result = await claw;
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    const id = result.outcome === 'clawed_back' ? result.rightsEventId : 'missing';
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(badDebtLines(o, 85n));
    expect(await h.balance(direct)).toBe(85n);
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#39] 同一逆向事件并发两次：后到的事务在锁上等待，前者提交后锁内重读为 CLAWED_BACK → 跳过；凭证只写一套，余额只扣一次',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.boot();
    const paused = deferred();
    const resume = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await resume.promise;
    });
    const firstPid = deferred<number>();
    const secondPid = deferred<number>();

    const first = h.apply(o, FULL, { via: p.left, onPid: (pid) => firstPid.resolve(pid) });
    await paused.promise;
    const second = h.apply(o, FULL, { via: p.right, onPid: (pid) => secondPid.resolve(pid) });
    await waitBlocked(p.control, await secondPid.promise, await firstPid.promise);
    resume.resolve();

    expect(await first).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await second).toEqual({ outcome: 'skipped', reason: 'not_credited' });
    expect(await h.clawbackKeys(o)).toHaveLength(4);
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect((await h.published()).filter((e) => e.name === 'order.clawed_back')).toHaveLength(1);
  },
  TIMEOUT,
);

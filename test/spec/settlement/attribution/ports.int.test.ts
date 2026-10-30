// B2-04la rule tests: settlement's attribution ports on a real PostgreSQL (BR-FUND-01 rebate_status
// table R3 / R3b, R4's guard for the WAITING branch; orders' ClaimApprovedInput / AdminAssignedInput).
// R3: UNATTRIBUTED --CLAIM_APPROVED / ADMIN_REASSIGN--> ESTIMATED, or WAITING when platform_status is
// already RECEIVED / SETTLED (settle_period from the original received_at), locked = true, no
// entries. R3b: VOID with empty user_id --ADMIN_REASSIGN--> VOID unchanged, locked = true. CLAIM_APPROVED
// is not part of R3b (决-07 A). Guard of both: locked = false. Out-of-table events change nothing and
// throw IllegalTransition with a log and an alert. user_id, user_basis and the history row are
// written by orders after the port (claim-review.ts / admin-assign.ts), never by the port.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/index.ts';
import { IllegalTransition } from '../../../../apps/api/src/modules/settlement/index.ts';
import {
  METHODS,
  NOW,
  PERIOD,
  RECEIVED,
  at,
  blockedBy,
  capture,
  expectAlert,
  expectCas,
  expectNoMoney,
  expectNoSqlClock,
  expectOnlyOrdersWritten,
  expectUntouched,
  fixture,
  type PortMethod,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const EVENT: Record<PortMethod, string> = {
  onClaimApproved: 'CLAIM_APPROVED',
  onAdminAssigned: 'ADMIN_REASSIGN',
};

const R3_ESTIMATED = METHODS.flatMap((method) =>
  (['PAID', 'DEPOSIT_PAID'] as const).map((status) => [method, status] as const),
);

it.each(R3_ESTIMATED)(
  '[AC-B2-04la#1] R3 %s：%s 的未归因订单 → ESTIMATED、locked=true，CAS 且 row_version+1、updated_at=input.now；不写 user_id / user_basis、不写历史、无分录',
  async (method, platformStatus) => {
    const f = await fixture(db, { platform_status: platformStatus });
    await f.call(method, { over: { snapshot: platformStatus === 'PAID' ? 'created' : 'none' } });

    expect(await f.read()).toEqual({
      ...f.initial,
      rebate_status: 'ESTIMATED',
      locked: true,
      row_version: f.initial.row_version + 1,
      updated_at: at(NOW),
    });
    expectCas(f);
    expectOnlyOrdersWritten(f);
    expect(await f.history()).toEqual([]);
    expectNoSqlClock(f);
    await expectNoMoney(db, f);
  },
);

const R3_WAITING = METHODS.flatMap((method) =>
  (['RECEIVED', 'SETTLED'] as const).map((status) => [method, status] as const),
);

it.each(R3_WAITING)(
  '[AC-B2-04la#2] R3 %s：平台已为 %s 且有 received_at → 直接 WAITING，settle_period 按原 received_at 取北京时间结算月，received_synced_at=input.now，locked=true',
  async (method, platformStatus) => {
    const f = await fixture(db, { platform_status: platformStatus, received_at: at(RECEIVED) });
    await f.call(method);

    expect(await f.read()).toEqual({
      ...f.initial,
      rebate_status: 'WAITING',
      locked: true,
      settle_period: PERIOD,
      received_synced_at: at(NOW),
      row_version: f.initial.row_version + 1,
      updated_at: at(NOW),
    });
    expectCas(f);
    expectOnlyOrdersWritten(f);
    expect(await f.history()).toEqual([]);
    expectNoSqlClock(f);
    await expectNoMoney(db, f);
  },
);

it.each(METHODS)(
  '[AC-B2-04la#3] R3 %s：时间只取 input.now——换一个 now，received_synced_at 与 updated_at 跟着变，settle_period 仍按 received_at（不按 now）',
  async (method) => {
    const f = await fixture(db, { platform_status: 'RECEIVED', received_at: at(RECEIVED) });
    const now = at('2027-03-04T05:06:07.000Z');
    await f.call(method, { over: { now } });

    expect(await f.read()).toMatchObject({
      rebate_status: 'WAITING',
      locked: true,
      settle_period: PERIOD,
      received_synced_at: now,
      updated_at: now,
    });
    expectNoSqlClock(f);
  },
);

it.each(METHODS)(
  '[AC-B2-04la#4] R3 %s：平台已收货但 received_at 取不到 → R4 守卫不过，只到 ESTIMATED（locked=true），不写 settle_period / received_synced_at',
  async (method) => {
    const f = await fixture(db, { platform_status: 'RECEIVED', received_at: null });
    await f.call(method);

    expect(await f.read()).toEqual({
      ...f.initial,
      rebate_status: 'ESTIMATED',
      locked: true,
      row_version: f.initial.row_version + 1,
      updated_at: at(NOW),
    });
    expectCas(f);
    await expectNoMoney(db, f);
  },
);

it.each([
  ['INVALID', 'REFUND'],
  ['PAID', 'COMMISSION_ZERO'],
] as const)(
  '[AC-B2-04la#5] R3b 后台指派：VOID（平台 %s、原因 %s）且 user_id 为空 → rebate_status 与原因不变，只置 locked=true（CAS、row_version+1），不写历史、无分录',
  async (platformStatus, reason) => {
    const f = await fixture(db, {
      platform_status: platformStatus,
      rebate_status: 'VOID',
      reason,
    });
    await f.call('onAdminAssigned', { over: { snapshot: 'none' } });

    expect(await f.read()).toEqual({
      ...f.initial,
      rebate_status: 'VOID',
      reason,
      locked: true,
      row_version: f.initial.row_version + 1,
      updated_at: at(NOW),
    });
    expectCas(f);
    expectOnlyOrdersWritten(f);
    expect(await f.history()).toEqual([]);
    expectNoSqlClock(f);
    await expectNoMoney(db, f);
  },
);

it('[AC-B2-04la#6] 找回通过不含 R3b（决-07 A）：VOID 订单收到 CLAIM_APPROVED 抛 IllegalTransition，订单任何列都不变，记日志并告警', async () => {
  const f = await fixture(db, {
    platform_status: 'INVALID',
    rebate_status: 'VOID',
    reason: 'REFUND',
  });
  const { error, current } = await f.call('onClaimApproved', { rescue: true });

  expect(error).toBeInstanceOf(IllegalTransition);
  expect(error).toMatchObject({ from: 'VOID', event: 'CLAIM_APPROVED' });
  await expectUntouched(f, current);
  expectAlert(f);
  await expectNoMoney(db, f);
});

const OUT_OF_TABLE = METHODS.flatMap((method) =>
  (['ESTIMATED', 'WAITING', 'CREDITED', 'CLAWED_BACK'] as const).map(
    (state) => [method, state] as const,
  ),
);

it.each(OUT_OF_TABLE)(
  '[AC-B2-04la#7] %s 只受理 R3 / R3b：写前快照为 %s（R14 不开放）→ 抛 IllegalTransition，判定先于写库，订单任何列都不变，记日志并告警',
  async (method, state) => {
    const f = await fixture(db, { rebate_status: state, platform_status: 'RECEIVED' });
    const { error, current } = await f.call(method, { rescue: true });

    expect(error).toBeInstanceOf(IllegalTransition);
    expect(error).toMatchObject({ from: state, event: EVENT[method] });
    await expectUntouched(f, current);
    expect(await f.history()).toEqual([]);
    expectAlert(f);
  },
);

const LOCKED_GUARD = [
  ['onClaimApproved', 'UNATTRIBUTED'],
  ['onAdminAssigned', 'UNATTRIBUTED'],
  ['onAdminAssigned', 'VOID'],
] as const;

it.each(LOCKED_GUARD)(
  '[AC-B2-04la#8] 守卫 orders.locked=false：%s 遇到已 locked 的 %s 订单 → 抛 IllegalTransition，不迁移、不改 locked，记日志并告警',
  async (method, state) => {
    const f = await fixture(db, {
      rebate_status: state,
      locked: true,
      ...(state === 'VOID' ? { platform_status: 'INVALID', reason: 'REFUND' } : {}),
    });
    const { error, current } = await f.call(method, { rescue: true });

    expect(error).toBeInstanceOf(IllegalTransition);
    expect(error).toMatchObject({ from: state, event: EVENT[method] });
    await expectUntouched(f, current);
    expectAlert(f);
  },
);

it('[AC-B2-04la#9] R3b 守卫「VOID 且 user_id 为空」：已有 user_id 的 VOID 订单后台指派 → 抛 IllegalTransition，订单不变，记日志并告警', async () => {
  const f = await fixture(db, {
    platform_status: 'INVALID',
    rebate_status: 'VOID',
    reason: 'REFUND',
  });
  await db
    .updateTable('orders')
    .set({ user_id: f.userId, user_basis: 'param' })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', f.orderId)
    .execute();
  const { error, current } = await f.call('onAdminAssigned', { rescue: true });

  expect(error).toBeInstanceOf(IllegalTransition);
  expect(error).toMatchObject({ from: 'VOID', event: 'ADMIN_REASSIGN' });
  await expectUntouched(f, current);
  expectAlert(f);
});

it.each(METHODS)(
  '[AC-B2-04la#10] %s 入参是写前快照：快照之后库内已被他人归属（ESTIMATED、locked=true、row_version 已变）→ CAS 不命中，不报成功，不覆盖库内的现值',
  async (method) => {
    const f = await fixture(db);
    const { error, current } = await f.call(method, {
      rescue: true,
      between: async (trx) => {
        await trx
          .updateTable('orders')
          .set({
            user_id: f.userId,
            user_basis: 'param',
            rebate_status: 'ESTIMATED',
            locked: true,
            row_version: f.initial.row_version + 1,
          })
          .where('app_id', '=', f.appId)
          .where('order_id', '=', f.orderId)
          .execute();
      },
    });

    expect(error).toBeInstanceOf(Error);
    expect(current).toMatchObject({ rebate_status: 'ESTIMATED', locked: true });
    await expectUntouched(f, current);
  },
);

it.each(METHODS)(
  '[AC-B2-04la#11] %s 只用调用方的事务：写入在同一事务里立即可见；调用方随后失败则整体回滚，订单回到写前',
  async (method) => {
    const f = await fixture(db);
    const seen: unknown[] = [];
    const failed = await capture(() =>
      f.call(method, {
        after: async (trx) => {
          seen.push(
            await trx
              .selectFrom('orders')
              .select(['rebate_status', 'locked'])
              .where('app_id', '=', f.appId)
              .where('order_id', '=', f.orderId)
              .executeTakeFirstOrThrow(),
          );
          throw new Error('synthetic caller failure');
        },
      }),
    );

    expect(seen).toEqual([{ rebate_status: 'ESTIMATED', locked: true }]);
    expect(failed.ok).toBe(false);
    expect(await f.read()).toEqual(f.initial);
  },
);

it.each(METHODS)(
  '[AC-B2-04la#12] %s 加锁照 B2-04m：先取 order_key advisory 锁（与 orders.lockOrderKey 同键）再读写订单行；不锁 users 行、不碰余额与分录',
  async (method) => {
    const f = await fixture(db);
    await f.call(method);

    const lockAt = f.portQueries.findIndex(
      (q) => /pg_advisory_xact_lock/i.test(q.sql) && q.parameters.includes(f.lockText),
    );
    const orderAt = f.portQueries.findIndex((q) => /"orders"/.test(q.sql));
    expect(lockAt, JSON.stringify(f.portQueries)).toBeGreaterThanOrEqual(0);
    expect(orderAt, JSON.stringify(f.portQueries)).toBeGreaterThan(lockAt);
    for (const q of f.portQueries) {
      expect(q.sql, q.sql).not.toMatch(/"users"|"account_balances"|"ledger_/);
    }
    await expectNoMoney(db, f);
  },
);

it.each(METHODS)(
  '[AC-B2-04la#13] %s 自己取 order_key 锁：另一连接持有同键 advisory 锁时，端口在锁上等待（PostgreSQL 可观测），对方提交后才写 ESTIMATED',
  async (method) => {
    const f = await fixture(db);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      held = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      await lockOrderKey(trx, f.platform, f.subOrderId);
      held(rows[0]!.pid);
      await released;
    });
    let outcome: Awaited<ReturnType<typeof capture>> = { ok: false, error: 'not run' };
    try {
      const pid = await holding;
      let finished = false;
      const calling = capture(() => f.raw(method, f.initial)).finally(() => {
        finished = true;
      });
      await blockedBy(db, pid, () => finished);
      expect(await f.read()).toEqual(f.initial);
      release();
      await holder;
      outcome = await calling;
    } finally {
      release();
      await holder;
    }

    expect(outcome).toEqual({ ok: true });
    expect(await f.read()).toMatchObject({ rebate_status: 'ESTIMATED', locked: true });
  },
);

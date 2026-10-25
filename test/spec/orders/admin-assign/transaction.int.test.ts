// BR-ATTR-20 ①③、BR-ATTR-31 细则「判定时点」：一个子订单锁、一个事务；锁内 FOR UPDATE 重读订单，同一事务
// 读目标用户的风控与注销状态；任一端口、审计、事件失败整事务回滚。只测应用服务（J-1 不挂载）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AdminAssignDeps } from '../../../../apps/api/src/modules/orders/application/admin-assign.ts';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import type { AuditInput } from '../../../../apps/api/src/modules/platform/index.ts';
import { gate } from '../../platform/queue/kit.ts';
import {
  assigned,
  blockedBy,
  fixture,
  open,
  reassignedEvents,
  untouched,
  type Fixture,
  type Harness,
  type Order,
} from './db-kit.ts';
import { CONFLICT, targetRefused } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

type Point = 'rebate' | 'snapshot' | 'audit' | 'event';
const POINTS: readonly Point[] = ['rebate', 'snapshot', 'audit', 'event'];

function failingAt(f: Fixture, point: Point, outage: Error): Partial<AdminAssignDeps> {
  if (point === 'rebate') {
    return {
      rebate: {
        onAdminAssigned: async (...args: Parameters<typeof f.deps.rebate.onAdminAssigned>) => {
          await f.deps.rebate.onAdminAssigned(...args);
          throw outage;
        },
      },
    };
  }
  if (point === 'snapshot') {
    return {
      snapshots: {
        create: async () => {
          throw outage;
        },
      },
    };
  }
  if (point === 'audit') {
    return {
      auditOn: (trx: Transaction<DB>) => ({
        append: async (input: AuditInput) => {
          await f.deps.auditOn(trx).append(input);
          throw outage;
        },
      }),
    };
  }
  return {
    events: {
      publish: async (...args: Parameters<typeof f.deps.events.publish>) => {
        await f.deps.events.publish(...args);
        throw outage;
      },
    },
  };
}

it.each(POINTS)(
  '[AC-B1-10f#14] %s 失败原样抛出，整事务回滚：归属、历史、order_assignments、他人找回子项、审计、事件都不留；重试只落一次',
  async (point) => {
    const f = await fixture(h);
    const o = await f.order();
    const other = await f.claim({ user_id: await f.user() });
    await f.item(other, o);
    const before = await f.state();
    const outage = new Error(`synthetic ${point} failure`);
    await expect(f.assign(o, {}, { deps: failingAt(f, point, outage) })).rejects.toBe(outage);
    const rolled = await f.state();
    untouched(rolled, before);
    expect(rolled.audits).toEqual(before.audits);

    assigned(await f.assign(o));
    const committed = await f.state();
    expect(committed.assignments).toHaveLength(1);
    expect(committed.audits).toHaveLength(1);
    expect(reassignedEvents(committed)).toHaveLength(1);
    expect(committed.items[0]).toMatchObject({
      decision: 'rejected',
      reject_reason: 'NOT_IN_POOL',
    });

    // A repeated submit finds the order attributed: 20902, nothing more is written.
    expect(await f.assign(o)).toEqual(CONFLICT);
    expect(await f.state()).toEqual(committed);
  },
);

it('[AC-B1-10f#15] 写入在提交前对其他连接不可见；端口、快照、审计、事件与两个目标读取共用同一个事务', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const before = await f.state();
  let observed = false;
  const publish = vi.fn<typeof f.deps.events.publish>(async (trx, event) => {
    const answer = await f.deps.events.publish(trx, event);
    const inside = await f.state(trx);
    expect(inside.orders[0]).toMatchObject({ user_id: f.subject.user_id, user_basis: 'admin' });
    expect(inside.assignments).toHaveLength(1);
    expect(reassignedEvents(inside)).toHaveLength(1);
    expect(inside.jobs).toHaveLength(1);
    untouched(await f.state(), before);
    observed = true;
    return answer;
  });
  assigned(await f.assign(o, {}, { deps: { events: { publish } } }));
  expect(observed).toBe(true);
  expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
  expect(f.targets.risk.read).toHaveBeenCalled();
  expect(f.targets.deletion.read).toHaveBeenCalled();
  const [trx] = f.rebate.onAdminAssigned.mock.calls[0]!;
  for (const call of [...f.targets.risk.read.mock.calls, ...f.targets.deletion.read.mock.calls]) {
    expect(call[0]).toBe(trx);
    expect(call[1]).toEqual({ appId: f.appId, userIds: [f.subject.user_id] });
  }
  expect(f.auditOn).toHaveBeenCalledTimes(1);
  expect(f.auditOn.mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[0]?.[0]).toBe(trx);
  expect(f.snapshots.create.mock.calls[0]?.[0]).toBe(trx);
});

it('[AC-B1-10f#16] 事务首句取子订单 advisory 锁，再 SELECT … FOR UPDATE 重读订单，之后才读目标用户的风控与注销状态', async () => {
  const f = await fixture(h);
  const o = await f.order();
  h.trace.length = 0;
  assigned(await f.assign(o));
  const queries = [...h.trace];
  const advisory = queries.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
  const reread = queries.findIndex(
    (q) => /from "app"\."orders"(?:\s|$)/i.test(q.sql) && /for update/i.test(q.sql),
  );
  const riskRead = queries.findIndex((q) => /"user_risk_state"/.test(q.sql));
  const stageRead = queries.findIndex((q) => /"deletion_requests"/.test(q.sql));
  expect(advisory).toBeGreaterThanOrEqual(0);
  expect(reread).toBeGreaterThan(advisory);
  expect(riskRead).toBeGreaterThan(reread);
  expect(stageRead).toBeGreaterThan(reread);
});

/**
 * Holds the sub-order advisory lock on another connection, starts the assignment, waits until
 * PostgreSQL shows it blocked behind that connection, applies `change` and commits.
 */
async function underForeignLock(
  f: Fixture,
  o: Order,
  request: () => ReturnType<Fixture['assign']>,
  change: (trx: Transaction<DB>) => Promise<void>,
  lock: 'advisory' | 'row' = 'advisory',
) {
  const ready = gate();
  const release = gate();
  let pid = 0;
  const writer = h.db.transaction().execute(async (trx) => {
    if (lock === 'advisory') await lockOrderKey(trx, o.platform, o.sub_order_id);
    else
      await trx
        .selectFrom('orders')
        .select('order_id')
        .where('app_id', '=', o.app_id)
        .where('order_id', '=', o.order_id)
        .forUpdate()
        .execute();
    pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
    ready.open();
    await release.wait();
    await change(trx);
  });
  // Any setup failure must release the waiter as well.
  void writer.catch(() => ready.open());
  await ready.wait();
  let finished = false;
  const running = request()
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      finished = true;
    });
  try {
    await blockedBy(h.db, pid, () => finished);
    expect((await f.state()).assignments).toEqual([]);
  } finally {
    release.open();
    await writer;
    await running;
  }
  const answer = await running;
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw answer.error;
  return answer.value;
}

it('[AC-B1-10f#17] 等锁期间订单被同步归属并锁定：锁内重读 user_id 非空 → 20902 order_attribution，不用锁前快照决定', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const other = await f.user();
  const result = await underForeignLock(
    f,
    o,
    () => f.assign(o),
    async (trx) => {
      await trx
        .updateTable('orders')
        .set({ user_id: other, user_basis: 'param', rebate_status: 'ESTIMATED' })
        .where('app_id', '=', o.app_id)
        .where('order_id', '=', o.order_id)
        .execute();
    },
  );
  expect(result).toEqual(CONFLICT);
  expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
  const s = await f.state();
  expect(s.orders).toEqual([
    { ...o, user_id: other, user_basis: 'param', rebate_status: 'ESTIMATED' },
  ]);
  expect(s.assignments).toEqual([]);
  expect(s.audits).toEqual([]);
}, 20_000);

it.each([
  ['被封禁', 'target_banned'],
  ['申请注销（冷静期）', 'target_deleting'],
] as const)(
  '[AC-B1-10f#18] 等锁期间目标用户%s：在指派事务里重读目标状态 → %s，订单不变',
  async (_label, reason) => {
    const f = await fixture(h);
    const o = await f.order();
    const target = await f.user();
    const result = await underForeignLock(
      f,
      o,
      () => f.assign(o, { user_id: target }),
      (trx) =>
        reason === 'target_banned'
          ? f.risk(target, 'banned', trx)
          : f.deletion(target, 'cooling', trx),
    );
    expect(result).toEqual(targetRefused(reason));
    expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
    expect(f.snapshots.create).not.toHaveBeenCalled();
    const s = await f.state();
    expect(s.orders).toEqual([o]);
    expect(s.assignments).toEqual([]);
  },
  20_000,
);

it('[AC-B1-10f#19] 订单行被另一事务 FOR UPDATE 锁住时指派等待；对方把订单置 VOID 后按重读的行走 R3b，端口入参是重读后的行', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const result = await underForeignLock(
    f,
    o,
    () => f.assign(o),
    async (trx) => {
      await trx
        .updateTable('orders')
        .set({ rebate_status: 'VOID', platform_status: 'INVALID' })
        .where('app_id', '=', o.app_id)
        .where('order_id', '=', o.order_id)
        .execute();
    },
    'row',
  );
  assigned(result);
  expect(f.snapshots.create).not.toHaveBeenCalled();
  expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
  expect(f.rebate.onAdminAssigned.mock.calls[0]?.[1]).toMatchObject({
    before: { ...o, rebate_status: 'VOID', platform_status: 'INVALID' },
    snapshot: 'none',
  });
  expect((await f.state()).orders[0]).toMatchObject({
    user_id: f.subject.user_id,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'VOID',
  });
}, 20_000);

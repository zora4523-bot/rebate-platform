import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import { gate } from '../../platform/queue/kit.ts';
import { decided, fixture, noAttribution, open, resolved, success, type Harness } from './kit.ts';

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

// Observe real PostgreSQL blocking, not a sleep that guesses which writer won.
async function blockedBy(pid: number, finished: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    expect(finished(), 'review must wait for the writer holding the order lock').toBe(false);
    const rows = await sql<{ query: string }>`select query from pg_stat_activity
      where ${pid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`.execute(h.db);
    if (rows.rows.length > 0) return;
    await pause(20);
  }
  expect.fail('PostgreSQL did not observe the required lock wait');
}

it.each(['self', 'other', 'void-approve', 'void-reject'] as const)(
  '[AC-B1-10k#20] 同步先持有 advisory 锁，审核等待后重读 %s，不能拿锁前快照决定',
  async (scenario) => {
    const f = await fixture(h);
    const o = await f.order();
    const c = await f.claim();
    const i = await f.item(c, o);
    const userId = scenario === 'self' ? c.user_id : await f.user();
    const ready = gate();
    const release = gate();
    let pid = 0;
    const writer = h.db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.sub_order_id);
      pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      ready.open();
      await release.wait();
      await trx
        .updateTable('orders')
        .set(
          scenario.startsWith('void')
            ? { rebate_status: 'VOID' }
            : { user_id: userId, user_basis: 'param', rebate_status: 'ESTIMATED' },
        )
        .where('order_id', '=', o.order_id)
        .execute();
    });
    // Any setup failure must release the waiter as well.
    void writer.catch(() => ready.open());
    await ready.wait();
    let finished = false;
    const review = f
      .review(scenario === 'void-reject' ? 'reject' : 'approve', i)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await blockedBy(pid, () => finished);
      expect((await f.state()).items[0]?.decision).toBeNull();
    } finally {
      release.open();
      await writer;
      await review;
    }
    const answer = await review;
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw answer.error;
    const d = success(answer.value);
    expect(d.status).toBe(scenario === 'self' ? 'cancelled' : 'rejected');
    await decided(
      f,
      i,
      scenario === 'self' ? 'cancelled' : 'rejected',
      scenario === 'self' ? null : scenario === 'other' ? 'NOT_IN_POOL' : 'ORDER_INVALID',
      null,
    );
    noAttribution(f);
    const current = (await f.state()).orders[0]!;
    expect(current).toEqual({
      ...o,
      ...(scenario.startsWith('void')
        ? { rebate_status: 'VOID' }
        : { user_id: userId, user_basis: 'param', rebate_status: 'ESTIMATED' }),
    });
  },
);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#21] %s 必须 SELECT FOR UPDATE 重读，普通行锁也阻塞审核',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order();
    const c = await f.claim();
    const i = await f.item(c, o);
    const ready = gate();
    const release = gate();
    let pid = 0;
    const writer = h.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('orders')
        .select('order_id')
        .where('order_id', '=', o.order_id)
        .forUpdate()
        .execute();
      pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      ready.open();
      await release.wait();
      await trx
        .updateTable('orders')
        .set({ rebate_status: 'VOID' })
        .where('order_id', '=', o.order_id)
        .execute();
    });
    void writer.catch(() => ready.open());
    await ready.wait();
    let finished = false;
    const review = f
      .review(mode, i)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await blockedBy(pid, () => finished);
    } finally {
      release.open();
      await writer;
      await review;
    }
    const answer = await review;
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw answer.error;
    expect(success(answer.value).items[0]?.reject_reason).toBe('ORDER_INVALID');
    noAttribution(f);
  },
);

it('[AC-B1-10k#22] 同子订单竞争审核先提交者胜，其他项系统驳回，过期请求 CAS 20902', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const a = await f.claim();
  const b = await f.claim({ user_id: await f.user() });
  const ai = await f.item(a, o);
  const bi = await f.item(b, o);
  const results = await Promise.all([f.review('approve', ai), f.review('approve', bi)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 20902]);
  expect(results.find((r) => r.code === 20902)).toEqual({
    code: 20902,
    data: { resource: 'claim_item' },
  });
  const s = await f.state();
  expect(s.items.filter((i) => i.decision === 'approved')).toHaveLength(1);
  const winner = s.items.find((i) => i.decision === 'approved')!;
  const loser = s.items.find((i) => i.decision === 'rejected')!;
  expect(loser).toMatchObject({ reject_reason: 'NOT_IN_POOL', decided_by: null, row_version: 1 });
  expect(s.orders[0]?.user_id).toBe(winner.applicant_user_id);
  expect(f.snapshots.create).toHaveBeenCalledTimes(1);
  expect(f.rebate.onClaimApproved).toHaveBeenCalledTimes(1);
  await resolved(f, [
    { claim_id: winner.claim_id, user_id: winner.applicant_user_id, status: 'approved' },
    { claim_id: loser.claim_id, user_id: loser.applicant_user_id, status: 'rejected' },
  ]);
});

it('[AC-B1-10k#23] 同项同时通过与驳回只有一次决定、审计和事件', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const i = await f.item(c, await f.order());
  const results = await Promise.all([f.review('approve', i), f.review('reject', i)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 20902]);
  const s = await f.state();
  expect(s.items[0]?.row_version).toBe(i.row_version + 1);
  expect(s.audits).toHaveLength(1);
  expect(s.events).toHaveLength(1);
  expect(s.jobs).toHaveLength(1);
  expect(s.claims[0]?.status).toBe(s.items[0]?.decision);
});

it('[AC-B1-10k#24] 同 claim 两子单并发审核不丢汇总：最后状态 approved，结案事件只有一次', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const a = await f.item(c, await f.order());
  const b = await f.item(c, await f.order());
  const results = await Promise.all([f.review('approve', a), f.review('reject', b)]);
  expect(results.map((r) => r.code)).toEqual([0, 0]);
  const s = await f.state();
  expect(s.claims[0]?.status).toBe('approved');
  expect(s.items.map((i) => i.decision).sort()).toEqual(['approved', 'rejected']);
  await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'approved' }]);
});

it('[AC-B1-10k#25] 跨 claim 交叉子单并发：先订单锁与重读，再一次按 claim id 升序锁全体，避免互等', async () => {
  const f = await fixture(h);
  const a = await f.claim({ id: '0190a600-0000-7000-8000-000000000001' });
  const b = await f.claim({ id: '0190a600-0000-7000-8000-000000000002', user_id: await f.user() });
  const x = await f.order();
  const y = await f.order();
  await f.item(a, x);
  const ay = await f.item(a, y);
  const bx = await f.item(b, x);
  await f.item(b, y);
  h.trace.length = 0;
  const results = await Promise.all([f.review('approve', bx), f.review('approve', ay)]);
  expect(results.map((r) => r.code)).toEqual([0, 0]);
  const queries = [...h.trace];
  const claimsLocks = queries.filter(
    (q) => /from "app"\."claims"(?:\s|$)/i.test(q.sql) && /for update/i.test(q.sql),
  );
  expect(claimsLocks).toHaveLength(2);
  for (const lock of claimsLocks) {
    expect(lock.sql).toMatch(/order by (?:"\w+"\.)?"id"(?: asc)?\s+for update/i);
    expect(JSON.stringify(lock.parameters)).toContain(a.id);
    expect(JSON.stringify(lock.parameters)).toContain(b.id);
  }
  const orderReads = queries.filter(
    (q) => /from "app"\."orders"(?:\s|$)/i.test(q.sql) && /for update/i.test(q.sql),
  );
  expect(orderReads).toHaveLength(2);
  const advisory = queries.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
  const read = queries.indexOf(orderReads[0]!);
  const claimLock = queries.indexOf(claimsLocks[0]!);
  expect(advisory).toBeGreaterThanOrEqual(0);
  expect(advisory).toBeLessThan(read);
  expect(read).toBeLessThan(claimLock);
  const s = await f.state();
  expect(s.claims.map((c) => c.status)).toEqual(['approved', 'approved']);
  expect(s.items.filter((i) => i.decision === 'approved')).toHaveLength(2);
  expect(s.items.filter((i) => i.reject_reason === 'NOT_IN_POOL')).toHaveLength(2);
  await resolved(f, [
    { claim_id: a.id, user_id: a.user_id, status: 'approved' },
    { claim_id: b.id, user_id: b.user_id, status: 'approved' },
  ]);
}, 20_000);

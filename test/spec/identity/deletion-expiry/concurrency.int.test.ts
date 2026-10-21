// B1-15f: concurrency of the expiry with itself and with a withdrawal of the request (08 BR-ID-27
// 「撤回条件以时间判定…与定时任务是否已执行无关」; brief §9.2 #3 「撤回与任务并发」: both lock the user's
// app.users row, the first to get it wins; rule-test list items 6, 7). Deterministic barriers only:
// a transaction the test holds open, a port call held on a promise, and a bounded poll of pg_locks.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  close,
  gate,
  heldTransaction,
  lockWaiters,
  open,
  owner,
  request,
  reset,
  seedRequest,
  userRow,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
beforeEach(async () => {
  await reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-15f#12] 两个实例并发：都排在测试持有的 users 行锁后面，放开后单与 users 各只写一次', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const user = await userRow(kit.db, o);
  const one = kit.runner();
  const two = kit.runner();
  const held = heldTransaction(kit.db, async (trx) => {
    await sql`SELECT id FROM app.users WHERE app_id = ${o.appId} AND id = ${o.uid}
      FOR UPDATE`.execute(trx);
  });
  await held.ready;
  const runs = Promise.all([one.runOnce(), two.runOnce()]);
  try {
    await lockWaiters(kit.db, 2);
  } finally {
    held.commit();
    await held.done;
  }
  await runs;
  const now = kit.clock.now();
  expect(await request(kit.db, original.id)).toEqual({
    ...original,
    status: 'processing',
    row_version: original.row_version + 1,
    updated_at: now,
  });
  expect(await userRow(kit.db, o)).toEqual({
    ...user,
    status: 'deleting',
    row_version: user.row_version + 1,
    updated_at: now,
  });
  // The loser rereads a request that is no longer cooling and asks no port.
  expect(kit.balanceCallsOf(o)).toHaveLength(1);
  expect(kit.withdrawalCallsOf(o)).toHaveLength(1);
});

it('[AC-B1-15f#13] 撤回先持 users 锁并提交 → 任务重读到 cancelled，不动、不问端口', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const user = await userRow(kit.db, o);
  const runner = kit.runner();
  // The user's withdrawal, one millisecond before the end of the cooling period (BR-ID-27).
  const withdrawnAt = new Date(original.cooling_until.getTime() - 1);
  const held = heldTransaction(kit.db, async (trx) => {
    await sql`SELECT id FROM app.users WHERE app_id = ${o.appId} AND id = ${o.uid}
      FOR NO KEY UPDATE`.execute(trx);
    await sql`UPDATE app.deletion_requests SET status = 'cancelled', cancel_reason = 'user',
      cancelled_at = ${withdrawnAt}, row_version = row_version + 1, updated_at = ${withdrawnAt}
      WHERE id = ${original.id} AND status = 'cooling'`.execute(trx);
  });
  await held.ready;
  const run = runner.runOnce();
  try {
    await lockWaiters(kit.db, 1);
  } finally {
    held.commit();
    await held.done;
  }
  await run;
  expect(await request(kit.db, original.id)).toEqual({
    ...original,
    status: 'cancelled',
    cancel_reason: 'user',
    cancelled_at: withdrawnAt,
    row_version: original.row_version + 1,
    updated_at: withdrawnAt,
  });
  expect(await userRow(kit.db, o)).toEqual(user);
  expect(kit.balanceCallsOf(o)).toEqual([]);
  expect(kit.withdrawalCallsOf(o)).toEqual([]);
});

it('[AC-B1-15f#14] 任务先持 users 锁 → 撤回排队，任务提交后撤回读到 processing', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const runner = kit.runner();
  const release = gate();
  const entered = gate();
  kit.hold(o, { hold: release.promise, entered: entered.open });
  const run = runner.runOnce();
  const reached = await Promise.race([
    entered.promise.then(() => 'entered' as const),
    run.then(() => 'finished' as const),
  ]);
  if (reached !== 'entered') release.open();
  expect(reached, 'the expiry never reached the withdrawal port').toBe('entered');
  // A withdrawal attempt: lock the user's row first (as B1-15d's cancel does), then read.
  const withdrawal = kit.db.transaction().execute(async (trx) => {
    await sql`SELECT id FROM app.users WHERE app_id = ${o.appId} AND id = ${o.uid}
      FOR NO KEY UPDATE`.execute(trx);
    const { rows } = await sql<{ status: string }>`SELECT status FROM app.deletion_requests
      WHERE id = ${original.id}`.execute(trx);
    return rows[0]!.status;
  });
  try {
    await lockWaiters(kit.db, 1);
  } finally {
    release.open();
  }
  await run;
  expect(await withdrawal).toBe('processing');
  expect((await request(kit.db, original.id)).status).toBe('processing');
  expect((await userRow(kit.db, o)).status).toBe('deleting');
});

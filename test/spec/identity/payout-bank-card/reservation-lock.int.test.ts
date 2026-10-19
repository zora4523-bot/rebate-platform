import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  account,
  bankBody,
  close,
  envelope,
  fixture,
  open,
  reset,
  state,
  until,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-13f#60] 预占必须等待 users 行锁；放锁前无核验记录及供应商调用，放锁后只占一次', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  expect(await f.attempts()).toEqual([]);
  let pending: ReturnType<typeof f.submit> | undefined;
  try {
    // Hold the user row from an independent connection before the real PUT starts.
    // FOR NO KEY UPDATE permits FK key-share locks, so inserting an attempt alone
    // cannot produce the blocking observation below.
    await kit.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', f.appId)
        .where('id', '=', f.uid)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      const holderPid = result.rows[0]!.pid;
      pending = f.submit(bankBody(), key);

      // Observe an actual database lock wait rather than assuming HTTP has reached
      // the critical section after a fixed sleep. Only this test holds this user row.
      await until(async () => {
        const result = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`.execute(kit.db);
        return result.rows[0]!.blocked;
      });
      expect(kit.verify).not.toHaveBeenCalled();
      expect(kit.query).not.toHaveBeenCalled();
      expect(await f.attempts()).toEqual([]);
      expect(await f.idempotency(key)).toEqual([]);
      expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
    });
  } finally {
    // The transaction above commits (or rolls back on assertion failure) before
    // awaiting HTTP, so failed assertions cannot leave the request behind a lock.
    await pending;
  }

  expect(pending).toBeDefined();
  envelope(kit, (await pending)!);
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(kit.query).not.toHaveBeenCalled();
  const attempts = await f.attempts();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    status: 'matched',
    idempotency_key: key,
  });
  const occupied = await kit.db
    .selectFrom('payout_account_verify_attempts')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.uid)
    .where(sql<string>`verify_date::text`, '=', '2026-10-18')
    .where('status', '!=', 'released')
    .execute();
  expect(occupied).toHaveLength(1);
  expect((await state(kit, f)).accounts).toHaveLength(1);
  expect(await f.idempotency(key)).toHaveLength(1);
});

it.each([false, true])(
  '[AC-B1-13f#61] 三要素不一致不新增账号、不改变当前绑定或变更流水（已有绑定=%s）',
  async (bound) => {
    const f = await fixture(kit);
    if (bound) await account(kit, f);
    const before = await state(kit, f);
    const key = randomUUID();
    kit.verify.mockResolvedValue('mismatch');

    const response = await f.submit(bankBody(), key);
    envelope(kit, response, 30307);
    expect(kit.verify).toHaveBeenCalledTimes(1);
    expect(await state(kit, f)).toEqual(before);
    const attempts = await f.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'mismatched', idempotency_key: key });
    expect(await f.idempotency(key)).toHaveLength(1);

    const replay = await f.submit(bankBody(), key, '');
    envelope(kit, replay, 30307);
    expect(replay.body).toBe(response.body);
    expect(await state(kit, f)).toEqual(before);
    expect(await f.attempts()).toEqual(attempts);
    expect(kit.verify).toHaveBeenCalledTimes(1);
    expect(kit.query).not.toHaveBeenCalled();
  },
);

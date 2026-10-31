// B1-15i: notification's writeDeletionProgressMessage (through notification/index.ts) on the
// caller's transaction (brief §9.2 #1, #4 and 09:5x: the dedupe key and notify_logs are written in
// the same transaction; a rollback leaves neither the message nor the log). Dedupe key
// `{deletion_request_id}:DELETION_PROGRESS:{variant}`, ON CONFLICT DO NOTHING: a repeat answers
// false and writes nothing; a concurrent repeat waits on the unique key and then writes nothing.
import { randomUUID } from 'node:crypto';
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { DeletionProgressInput } from '../../../../apps/api/src/modules/notification/index.ts';
import { NOW, heldTransaction, lockWaiters, owner } from '../deletion-expiry/kit.ts';
import {
  CANCELLED_BODY,
  expectInboxOnly,
  expectedLog,
  expectedMessage,
  inbox,
  logs,
  messageApi,
  negativeBody,
  requestedBody,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

async function subject() {
  const o = await owner(db);
  return { appId: o.appId, userId: o.uid, base: { app_id: o.appId, user_id: o.uid } } as const;
}

it('[AC-B1-15i#40] 同一申请同一变体写两次 → 第二次 false、不再写；同申请别的变体、别的申请各自一条', async () => {
  const api = await messageApi();
  const s = await subject();
  const clock = new FixedClock(NOW);
  const at = clock.now();
  const r1 = randomUUID();
  const r2 = randomUUID();
  const requested: DeletionProgressInput = {
    ...s.base,
    deletion_request_id: r1,
    variant: 'requested',
    cancel_deadline: new Date('2026-10-28T04:00:00.000Z'),
  };
  const write = (input: DeletionProgressInput) =>
    db.transaction().execute((trx) => api.writeDeletionProgressMessage(trx, input, { clock }));
  expect(await write(requested)).toBe(true);
  expect(await write(requested)).toBe(false);
  expect(await write({ ...s.base, deletion_request_id: r1, variant: 'cancelled' })).toBe(true);
  expect(
    await write({
      ...s.base,
      deletion_request_id: r2,
      variant: 'cancelled_negative',
      amount_fen: 1n,
    }),
  ).toBe(true);
  expect(
    await write({
      ...s.base,
      deletion_request_id: r2,
      variant: 'cancelled_negative',
      amount_fen: 9n,
    }),
  ).toBe(false);
  const messages = await inbox(db, s.appId);
  expect(messages.map((row) => row.body).sort()).toEqual(
    [requestedBody('10-28 12:00'), CANCELLED_BODY, negativeBody('¥0.01')].sort(),
  );
  for (const row of messages) {
    expect(row).toMatchObject(
      expectedMessage({ appId: s.appId, userId: s.userId, body: row.body, at }),
    );
  }
  const rows = await logs(db, s.appId);
  expect(rows).toHaveLength(3);
  for (const [requestId, variant] of [
    [r1, 'requested'],
    [r1, 'cancelled'],
    [r2, 'cancelled_negative'],
  ] as const) {
    expect(rows).toContainEqual(
      expect.objectContaining(
        expectedLog({ appId: s.appId, userId: s.userId, requestId, variant, at }),
      ),
    );
  }
  await expectInboxOnly(db, s.appId);
});

it('[AC-B1-15i#41] 写在调用方事务上：事务内可见、提交前别的连接看不到；事务回滚 → 站内信与日志都不留', async () => {
  const api = await messageApi();
  const s = await subject();
  const clock = new FixedClock(NOW);
  const id = randomUUID();
  const outcome = db.transaction().execute(async (trx) => {
    expect(
      await api.writeDeletionProgressMessage(
        trx,
        { ...s.base, deletion_request_id: id, variant: 'cancelled' },
        { clock },
      ),
    ).toBe(true);
    expect(await inbox(trx, s.appId)).toHaveLength(1);
    expect(await logs(trx, s.appId)).toHaveLength(1);
    expect(await inbox(db, s.appId)).toEqual([]);
    expect(await logs(db, s.appId)).toEqual([]);
    throw new Error('business write failed after the notice');
  });
  await expect(outcome).rejects.toThrow('business write failed after the notice');
  expect(await inbox(db, s.appId)).toEqual([]);
  expect(await logs(db, s.appId)).toEqual([]);
  // Nothing was left behind to block the next attempt: it writes the message.
  expect(
    await db
      .transaction()
      .execute((trx) =>
        api.writeDeletionProgressMessage(
          trx,
          { ...s.base, deletion_request_id: id, variant: 'cancelled' },
          { clock },
        ),
      ),
  ).toBe(true);
  expect((await inbox(db, s.appId)).map((row) => row.body)).toEqual([CANCELLED_BODY]);
});

it('[AC-B1-15i#42] 并发同键：后到的等先到的事务结束，再按去重键不写（false），只一条', async () => {
  const api = await messageApi();
  const s = await subject();
  const clock = new FixedClock(NOW);
  const input: DeletionProgressInput = {
    ...s.base,
    deletion_request_id: randomUUID(),
    variant: 'cancelled_negative',
    amount_fen: 1234n,
  };
  const first = heldTransaction(db, (trx) =>
    api.writeDeletionProgressMessage(trx, input, { clock }),
  );
  expect(await first.ready).toBe(true);
  const second = db
    .transaction()
    .execute((trx) => api.writeDeletionProgressMessage(trx, input, { clock }));
  await lockWaiters(db, 1);
  first.commit();
  await first.done;
  expect(await second).toBe(false);
  expect((await inbox(db, s.appId)).map((row) => row.body)).toEqual([negativeBody('¥12.34')]);
  expect(await logs(db, s.appId)).toHaveLength(1);
});

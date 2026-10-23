// B1-15g: idempotence and concurrency (brief §9.2 #2, #3 lock order users → deletion_requests,
// CAS on the progress columns; §9.3 item 10). A repeated round writes nothing; two runner
// instances on the same request: the later one waits on the user's row lock (seen in pg_locks)
// while the first holds the cleanup transaction, and every step is written once; two Apple
// attempts racing outside the transaction count once.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  HOUR_MS,
  PORT_NAMES,
  at,
  close,
  deferred,
  deletedIdentitiesOf,
  device,
  footprint,
  gate,
  lockWaiters,
  oauth,
  open,
  processing,
  request,
  reset,
  session,
  settledOrWaiting,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

async function withDevice() {
  const { m, row } = await processing(kit.db);
  const d = await device(kit.db, m.appId);
  await session(kit.db, m, d.id);
  await oauth(kit.db, m, 'wechat');
  return { m, row };
}

it('[AC-B1-15g#24] runOnce 连跑两次：第二次什么都不写，端口不再调，deleted_identities 不重复，row_version 只 +1', async () => {
  const { m, row } = await withDevice();
  const runner = kit.runner();
  await runner.runOnce();
  const after = await footprint(kit.db, m, row.id);
  expect(after.request).toMatchObject({ status: 'done', row_version: row.row_version + 1 });
  expect(after.identities).toHaveLength(2);
  const callCount = kit.calls.length;
  kit.clock.set(at(HOUR_MS));
  await runner.runOnce();
  await kit.runner().runOnce();
  expect(await footprint(kit.db, m, row.id)).toEqual(after);
  expect(kit.calls).toHaveLength(callCount);
  expect(kit.revokedHooks).toHaveLength(1);
});

it('[AC-B1-15g#25] 两个实例并发处理同一单：后到者在 users 行锁上等待（pg_locks），清理、完成各只写一次', async () => {
  const { m, row } = await withDevice();
  const entered = deferred<void>();
  const release = gate();
  kit.hold('growth', { hold: release.promise, entered: () => entered.resolve() });
  const first = kit.runner();
  const second = kit.runner();
  const a = first.runOnce();
  await entered.promise;
  const b = second.runOnce();
  await lockWaiters(kit.db, 1);
  release.open();
  await Promise.all([a, b]);
  for (const name of PORT_NAMES) {
    expect(kit.callsOf(name, m), name).toHaveLength(1);
  }
  expect(kit.callsOf('funds', m)).toHaveLength(1);
  expect(kit.revokedHooks).toHaveLength(1);
  const now = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: now,
    cleaned_at: now,
    apple_revoke_result: 'not_applicable',
    row_version: row.row_version + 1,
    updated_at: now,
  });
  expect(await deletedIdentitiesOf(kit.db, m.appId)).toHaveLength(2);
});

it('[AC-B1-15g#26] 两个实例同时做 Apple 撤销：attempts 只记一次、结果 revoked，单只完成一次', async () => {
  const { m, row } = await processing(kit.db);
  await oauth(kit.db, m, 'apple', { appleToken: 'synthetic-apple-token', crypto: kit.crypto });
  // The first instance cleans the request and is held inside its Apple attempt…
  const entered = deferred<void>();
  const release = gate();
  kit.hold('apple', { hold: release.promise, entered: () => entered.resolve() });
  const first = kit.runner();
  const second = kit.runner();
  const a = first.runOnce();
  await entered.promise;
  // …while the first instance's attempt is held, the second one runs its own round.
  const b = second.runOnce();
  await settledOrWaiting(kit.db, b);
  release.open();
  await Promise.all([a, b]);
  expect(kit.appleCalls.length).toBeGreaterThanOrEqual(1);
  expect(kit.appleCalls.length).toBeLessThanOrEqual(2);
  const now = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: now,
    cleaned_at: now,
    apple_revoke_attempts: 1,
    apple_revoke_result: 'revoked',
    row_version: row.row_version + 1,
    updated_at: now,
  });
  expect(kit.callsOf('growth', m)).toHaveLength(1);
});

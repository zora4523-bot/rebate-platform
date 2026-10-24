// F1-02zzk (brief §9.2 #3, §9.3 item 4; connected): what app.module assembles for the worker's
// deletion processing, over PostgreSQL (couli_app of a cloned test database).
// - The assembled notification port, called as identity calls it, deletes the user's push tokens
//   in the app and nothing else.
// - One round of the assembled deletion runner (B1-15g): afterwards no push_tokens row of the app
//   carries the deleted user (a token bound to a live session is unbound by the session
//   revocation, every other one is deleted by the notification port), other users' tokens and the
//   user's inbox messages, send records and switches stay; the daily cleanup_blocked warning no
//   longer names notification. Only facts that hold whichever other owner ports are shipped are
//   asserted (cleaned_at and done depend on them).
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  CLEANUP_BLOCKED,
  DAY_MS,
  TOMBSTONE_NICKNAME,
  assembledCleanup,
  assembledRunner,
  at,
  device,
  inputOf,
  lockUser,
  member,
  newAppId,
  notificationStep,
  ports,
  processing,
  retainedOf,
  seedMemberTokens,
  seedRetained,
  seedToken,
  session,
  tokensOf,
  userRow,
  warnings,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  vi.restoreAllMocks();
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

it('[AC-F1-02zzk#5] 装配版 notification 端口在真实库上：删该用户在该 app 的全部令牌；同 app 其他用户、无主令牌、其他 app 令牌与站内信、发送记录、通知设置不变', async () => {
  const appId = newAppId();
  const x = await member(db, { appId });
  const y = await member(db, { appId, status: 'normal' });
  const xTokens = await seedMemberTokens(db, x);
  await seedMemberTokens(db, y);
  const shared = await device(db, appId);
  await seedToken(db, { appId, deviceId: shared.id, userId: null });
  const other = await member(db, { appId: newAppId(), status: 'normal' });
  await seedMemberTokens(db, other);
  await seedRetained(db, x);
  await seedRetained(db, y);
  const before = await tokensOf(db, appId);
  const otherBefore = await tokensOf(db, other.appId);
  const retained = await retainedOf(db, appId);

  const p = await ports();
  const assembled = await assembledCleanup(p, db);
  try {
    const step = notificationStep(assembled.ports);
    await db.transaction().execute(async (trx) => {
      await lockUser(trx, x);
      await step(trx, inputOf(x, p.clock.now()));
    });
  } finally {
    await assembled.close();
  }

  expect(await tokensOf(db, appId)).toEqual(before.filter((row) => !xTokens.includes(row.id)));
  expect(await tokensOf(db, other.appId)).toEqual(otherBefore);
  expect(await retainedOf(db, appId)).toEqual(retained);
}, 60_000);

it('[AC-F1-02zzk#6] 装配版注销处理一轮后该用户在该 app 不再有带其 user_id 的推送令牌；同 app 其他用户令牌、该用户站内信 / 发送记录 / 通知设置不变；cleanup_blocked 不再点名 notification', async () => {
  const appId = newAppId();
  const x = await processing(db, { appId });
  const live = await device(db, appId);
  const sid = await session(db, x.m, live.id);
  await seedToken(db, { appId, deviceId: live.id, userId: x.m.uid, boundSid: sid });
  // Tokens the session revocation does not unbind: a stale binding, a revoked and a frozen one.
  const stale = await device(db, appId);
  await seedToken(db, { appId, deviceId: stale.id, userId: x.m.uid });
  await seedToken(db, {
    appId,
    deviceId: stale.id,
    userId: x.m.uid,
    provider: 'fcm',
    revokedAt: at(-DAY_MS),
  });
  const frozen = await device(db, appId);
  await seedToken(db, {
    appId,
    deviceId: frozen.id,
    userId: x.m.uid,
    boundSid: null,
    frozenUntil: at(3 * DAY_MS),
  });
  const y = await member(db, { appId, status: 'normal' });
  const yTokens = await seedMemberTokens(db, y);
  await seedRetained(db, x.m);
  await seedRetained(db, y);
  const yBefore = (await tokensOf(db, appId)).filter((row) => yTokens.includes(row.id));
  const retained = await retainedOf(db, appId);

  const p = await ports();
  const assembled = await assembledRunner(p, db);
  try {
    await assembled.runner.runOnce();
  } finally {
    await assembled.close();
  }

  // The round did run the user's cleanup (identity's own share committed).
  expect((await userRow(db, x.m)).nickname).toBe(TOMBSTONE_NICKNAME);
  const after = await tokensOf(db, appId);
  expect(after.filter((row) => row.user_id === x.m.uid)).toEqual([]);
  expect(after.filter((row) => yTokens.includes(row.id))).toEqual(yBefore);
  const kept = await retainedOf(db, appId);
  expect({ inbox: kept.inbox, logs: kept.logs, settings: kept.settings }).toEqual({
    inbox: retained.inbox,
    logs: retained.logs,
    settings: retained.settings,
  });
  expect(
    warnings(p, CLEANUP_BLOCKED, appId).filter((line) => line['port'] === 'notification'),
  ).toEqual([]);
}, 60_000);

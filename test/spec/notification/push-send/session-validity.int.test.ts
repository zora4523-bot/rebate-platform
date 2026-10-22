import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPushSessionValidity } from '../../../../apps/api/src/modules/identity/ports/push-session-validity.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { NOW, seedSession, seedUser } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
}, 60_000);
afterAll(async () => {
  if (readonlyDb) await destroyDb(readonlyDb);
  if (db) await destroyDb(db);
  if (database) await database.drop();
}, 60_000);

async function owner() {
  const app_id = `session-read-${randomUUID()}`;
  return { app_id, user_id: await seedUser(db, app_id) };
}

it('[AC-B1-12o#20] identity 只读口返回指定收件人的有效 sid，排除吊销、无刷新记录、过期和不存在', async () => {
  const subject = await owner();
  const clock = new FixedClock(NOW);
  const valid = await seedSession(db, subject);
  const revoked = await seedSession(db, subject, { revoked_at: clock.now() });
  const expired = await seedSession(db, subject, {
    expire_at: new Date(clock.now().getTime() - 1),
  });
  const absentRefresh = await seedSession(db, subject, { noRefresh: true });
  const another = await seedSession(db, {
    ...subject,
    user_id: await seedUser(db, subject.app_id),
  });
  const unrequested = await seedSession(db, subject);
  const sessionsBefore = await db
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', subject.app_id)
    .orderBy('sid')
    .execute();
  const refreshBefore = await db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('app_id', '=', subject.app_id)
    .orderBy('id')
    .execute();
  const read = createPushSessionValidity(clock);
  const result = await read(readonlyDb, {
    ...subject,
    sids: [
      valid.sid,
      valid.sid,
      revoked.sid,
      expired.sid,
      absentRefresh.sid,
      another.sid,
      'session-absent',
    ],
  });
  expect([...result]).toEqual([valid.sid]);
  expect(result.has(unrequested.sid)).toBe(false);
  expect(
    await db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', subject.app_id)
      .orderBy('sid')
      .execute(),
  ).toEqual(sessionsBefore);
  expect(
    await db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', subject.app_id)
      .orderBy('id')
      .execute(),
  ).toEqual(refreshBefore);
});

it.each([-1, 0, 1])(
  '[AC-B1-12o#21] refresh 到期相对 Clock 为 %s 毫秒，仅严格晚于此刻有效',
  async (offset) => {
    const subject = await owner();
    const clock = new FixedClock(NOW);
    const session = await seedSession(db, subject, {
      expire_at: new Date(clock.now().getTime() + offset),
    });
    const read = createPushSessionValidity(clock);
    expect([...(await read(readonlyDb, { ...subject, sids: [session.sid] }))]).toEqual(
      offset > 0 ? [session.sid] : [],
    );
  },
);

it('[AC-B1-12o#22] 每次读取使用注入 Clock，不缓存已经到期的会话', async () => {
  const subject = await owner();
  const clock = new FixedClock(NOW);
  const session = await seedSession(db, subject, {
    expire_at: new Date(clock.now().getTime() + 1),
  });
  const read = createPushSessionValidity(clock);
  expect([...(await read(readonlyDb, { ...subject, sids: [session.sid] }))]).toEqual([session.sid]);
  clock.advanceMs(1);
  expect([...(await read(readonlyDb, { ...subject, sids: [session.sid] }))]).toEqual([]);
});

it('[AC-B1-12o#23] sessions 与 refresh 的关联同时限定 app_id，不能借用另一应用同名 sid', async () => {
  const a = await owner();
  const b = await owner();
  const sessionA = await seedSession(db, a, { noRefresh: true });
  await seedSession(db, b, { sid: sessionA.sid });
  const read = createPushSessionValidity(new FixedClock(NOW));
  expect([...(await read(readonlyDb, { ...a, sids: [sessionA.sid] }))]).toEqual([]);
  expect([...(await read(readonlyDb, { ...b, sids: [sessionA.sid] }))]).toEqual([sessionA.sid]);
  expect([...(await read(readonlyDb, { ...a, app_id: b.app_id, sids: [sessionA.sid] }))]).toEqual(
    [],
  );
});

it('[AC-B1-12o#24] 刷新轮换后按当前有效记录判定，不被旧过期记录否决，也不接受仅有旧已轮换记录', async () => {
  const subject = await owner();
  const clock = new FixedClock(NOW);
  const renewed = await seedSession(db, subject, {
    rotated: true,
    expire_at: new Date(clock.now().getTime() - 1),
  });
  await db
    .insertInto('refresh_tokens')
    .values({
      id: randomUUID(),
      app_id: subject.app_id,
      sid: renewed.sid,
      token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      expire_at: new Date(clock.now().getTime() + 1),
    })
    .execute();
  const rotatedOnly = await seedSession(db, subject, { rotated: true });
  const read = createPushSessionValidity(clock);
  expect([
    ...(await read(readonlyDb, { ...subject, sids: [renewed.sid, rotatedOnly.sid] })),
  ]).toEqual([renewed.sid]);
});

it('[AC-B1-12o#25] 空 sid 列表返回空集合，不展开为全部会话', async () => {
  const subject = await owner();
  await seedSession(db, subject);
  // Exercise the public export without pulling Nest controller syntax into the test compiler.
  const identity = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as { createPushSessionValidity: typeof createPushSessionValidity };
  const read = identity.createPushSessionValidity(new FixedClock(NOW));
  expect([...(await read(readonlyDb, { ...subject, sids: [] }))]).toEqual([]);
});

it('[AC-B1-12o#26] 使用调用方事务看见未提交的会话吊销，不另开连接读取旧状态', async () => {
  const subject = await owner();
  const clock = new FixedClock(NOW);
  const session = await seedSession(db, subject);
  const read = createPushSessionValidity(clock);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('sessions')
      .set({ revoked_at: clock.now(), updated_at: clock.now() })
      .where('app_id', '=', subject.app_id)
      .where('sid', '=', session.sid)
      .execute();
    expect([...(await read(trx, { ...subject, sids: [session.sid] }))]).toEqual([]);
  });
});

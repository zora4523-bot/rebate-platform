// F1-02zzk (brief §9.3 items 1–3): notification's deletion cleanup port deletePushTokensForUser,
// called the way identity's cleanup calls it — on the caller's transaction, after the user's row
// is locked, with { appId, userId, at } — over the business role couli_app of a cloned test
// database. The push_tokens rows of (app, user) are deleted in every state; other users' rows,
// rows without a user and other apps' rows stay byte for byte; inbox_messages, notify_logs,
// notification_settings, devices and users rows stay as they were (BR-ID-30 retention; D10-311 ①).
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY_MS,
  at,
  deleteTokens,
  device,
  inputOf,
  lockUser,
  member,
  newAppId,
  seedMemberTokens,
  seedRetained,
  seedToken,
  tokensOf,
  untouchedOf,
  type Member,
  type TokenRow,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
}, 180_000);
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

/** The deleting member X, another member Y of the same app and the app's neighbours. */
async function scene() {
  const appId = newAppId();
  const x = await member(db, { appId });
  const y = await member(db, { appId, status: 'normal' });
  const xTokens = await seedMemberTokens(db, x);
  const yTokens = await seedMemberTokens(db, y);
  const shared = await device(db, appId);
  const unbound = await seedToken(db, { appId, deviceId: shared.id, userId: null });
  const other = await member(db, { appId: newAppId(), status: 'normal' });
  const otherTokens = await seedMemberTokens(db, other);
  return { appId, x, y, xTokens, yTokens, unbound, other, otherTokens };
}

/** Runs the port for `m` in a transaction of its own that locks the user's row first. */
function cleanUp(m: Member, when?: Date) {
  return db.transaction().execute(async (trx) => {
    await lockUser(trx, m);
    return deleteTokens(trx, inputOf(m, when));
  });
}

it('[AC-F1-02zzk#1] 删除该 app × 该用户的全部推送令牌（已绑定、同设备另一推送通道、已撤销、冻结中、未绑会话但仍带该用户）；同 app 其他用户、无主令牌、其他 app 的令牌逐字段不变', async () => {
  const s = await scene();
  const before = await tokensOf(db, s.appId);
  const otherBefore = await tokensOf(db, s.other.appId);
  expect(before.filter((row) => row.user_id === s.x.uid)).toHaveLength(4);

  const result = await cleanUp(s.x);

  expect(result).toMatchObject({ deleted: 4 });
  const after = await tokensOf(db, s.appId);
  expect(after.filter((row) => row.user_id === s.x.uid)).toEqual([]);
  expect(after.some((row) => s.xTokens.includes(row.id))).toBe(false);
  // Everything else of the app, Y's rows and the token without a user, is exactly as before.
  expect(after).toEqual(before.filter((row) => !s.xTokens.includes(row.id)));
  expect(after.map((row) => row.id).sort()).toEqual([...s.yTokens, s.unbound].sort());
  expect(await tokensOf(db, s.other.appId)).toEqual(otherBefore);
}, 60_000);

it('[AC-F1-02zzk#2] 只用调用方事务：事务内已删，调用方回滚后令牌原样都在', async () => {
  const s = await scene();
  const before = await tokensOf(db, s.appId);
  const rollback = new Error('fixture rollback');
  const seen: { inside?: TokenRow[] } = {};
  try {
    await db.transaction().execute(async (trx) => {
      await lockUser(trx, s.x);
      await deleteTokens(trx, inputOf(s.x));
      seen.inside = await tokensOf(trx, s.appId);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(seen.inside, 'the transaction did not reach its read').toBeDefined();
  expect(seen.inside?.filter((row) => row.user_id === s.x.uid)).toEqual([]);
  expect(seen.inside?.map((row) => row.id).sort()).toEqual([...s.yTokens, s.unbound].sort());
  // Rolled back with the caller: not one row was deleted on a connection of its own.
  expect(await tokensOf(db, s.appId)).toEqual(before);
}, 60_000);

it('[AC-F1-02zzk#3] 可重入：同一事务里连调两次、之后另一事务再调，都不抛错、第二次起删 0 行，结果与调一次相同', async () => {
  const s = await scene();
  const before = await tokensOf(db, s.appId);
  const results = await db.transaction().execute(async (trx) => {
    await lockUser(trx, s.x);
    const first = await deleteTokens(trx, inputOf(s.x));
    const second = await deleteTokens(trx, inputOf(s.x));
    return [first, second];
  });
  expect(results).toMatchObject([{ deleted: 4 }, { deleted: 0 }]);
  const once = await tokensOf(db, s.appId);
  expect(once).toEqual(before.filter((row) => !s.xTokens.includes(row.id)));

  // A later round (the cleanup runs again while another port is still unavailable).
  const again = await cleanUp(s.x, at(DAY_MS));
  expect(again).toMatchObject({ deleted: 0 });
  expect(await tokensOf(db, s.appId)).toEqual(once);
}, 60_000);

it('[AC-F1-02zzk#3] 该用户没有任何令牌时调用不抛错、删 0 行，app 内其他令牌不变', async () => {
  const s = await scene();
  const empty = await member(db, { appId: s.appId });
  const before = await tokensOf(db, s.appId);
  const result = await cleanUp(empty);
  expect(result).toMatchObject({ deleted: 0 });
  expect(await tokensOf(db, s.appId)).toEqual(before);
}, 60_000);

it('[AC-F1-02zzk#4] 站内信、推送与短信发送记录、通知设置、设备与用户行都不动（BR-ID-30 各自留存期；D10-311 ①），只少了该用户的令牌', async () => {
  const s = await scene();
  await seedRetained(db, s.x);
  await seedRetained(db, s.y);
  const before = await untouchedOf(db, s.appId, [s.x, s.y]);
  expect(before.inbox.filter((row) => row.user_id === s.x.uid)).toHaveLength(2);
  expect(before.logs.filter((row) => row.user_id === s.x.uid)).toHaveLength(4);
  expect(before.settings.filter((row) => row.user_id === s.x.uid)).toHaveLength(1);

  await cleanUp(s.x);

  expect(await untouchedOf(db, s.appId, [s.x, s.y])).toEqual(before);
  expect((await tokensOf(db, s.appId)).filter((row) => row.user_id === s.x.uid)).toEqual([]);
}, 60_000);

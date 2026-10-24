// B1-06zc: linking's deletion cleanup port blockForDeletion (08 BR-ID-28 细则「注销删除与保留范围」:
// 联盟绑定 blocked（blocked_reason=deletion）, 已封禁用户保持 ban, 释放见 BR-ID-20; identity's
// DeletionCleanupStep: on the caller's transaction, users row already locked, re-entrant).
// Only the orchestrator runs this file, with the shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { blockForDeletion } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  AT,
  DAY_MS,
  STATES,
  bind,
  bindingsOf,
  bindingsOfApp,
  blockedForDeletion,
  everyState,
  linkLog,
  linkLogsOf,
  lockUser,
  rolledBack,
  shift,
  subject,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it.each(STATES)(
  '[AC-B1-06zc#1] 注销清理：$platform 绑定 $status/$blocked_reason → 可停用的改 blocked(deletion)，其余原样',
  async (state) => {
    const s = await subject(db);
    const row = await bind(db, s, {
      platform: state.platform,
      status: state.status,
      blocked_reason: state.blocked_reason,
    });
    await db
      .transaction()
      .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));
    expect(await bindingsOf(db, s)).toStrictEqual([state.blocks ? blockedForDeletion(row) : row]);
  },
);

it('[AC-B1-06zc#2] 一次调用覆盖该用户全部平台：active / invalid / pending_auth 全改 blocked(deletion)；已 blocked（ban、admin_disable、deletion）、released、unbound 与历史行不动，不增删行', async () => {
  const s = await subject(db);
  const { rows, history } = await everyState(db, s);
  const before = await bindingsOf(db, s);
  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));
  const after = await bindingsOf(db, s);
  expect(after.map((row) => row.id)).toStrictEqual(before.map((row) => row.id));
  for (const { state, row } of rows) {
    expect(
      after.find((candidate) => candidate.id === row.id),
      `${state.platform}/${state.status}/${state.blocked_reason}`,
    ).toStrictEqual(state.blocks ? blockedForDeletion(row) : row);
  }
  expect(after.find((candidate) => candidate.id === history.id)).toStrictEqual(history);
  // 已封禁用户保持 ban：注销不把 ban 改写成 deletion。
  expect(after.filter((row) => row.blocked_reason === 'ban')).toHaveLength(1);
});

it('[AC-B1-06zc#3] 可重入：同一事务内再调、提交后换更晚的 at 再调，都不再改任何行（row_version、updated_at 停在第一次）', async () => {
  const s = await subject(db);
  await everyState(db, s);
  const input = { appId: s.appId, userId: s.userId };
  const once = await db.transaction().execute(async (trx) => {
    await blockForDeletion(trx, { ...input, at: AT });
    const first = await bindingsOf(trx, s);
    expect(first.filter((row) => row.blocked_reason === 'deletion')).toHaveLength(4);
    await blockForDeletion(trx, { ...input, at: shift(AT, 1) });
    expect(await bindingsOf(trx, s)).toStrictEqual(first);
    return first;
  });
  expect(await bindingsOf(db, s)).toStrictEqual(once);
  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { ...input, at: shift(AT, DAY_MS) }));
  expect(await bindingsOf(db, s)).toStrictEqual(once);
});

it('[AC-B1-06zc#4] 只用调用方事务：提交前别的连接看不到改动，调用方回滚后全部绑定复原', async () => {
  const s = await subject(db);
  await everyState(db, s);
  const before = await bindingsOf(db, s);
  // rolledBack catches only its own rollback sentinel; NotImplemented must propagate.
  await rolledBack(db, async (trx) => {
    await blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT });
    const inside = await bindingsOf(trx, s);
    expect(inside).toStrictEqual(
      before.map((row) =>
        ['active', 'invalid', 'pending_auth'].includes(row.status) ? blockedForDeletion(row) : row,
      ),
    );
    expect(await bindingsOf(db, s)).toStrictEqual(before);
  });
  expect(await bindingsOf(db, s)).toStrictEqual(before);
});

it('[AC-B1-06zc#5] 调用方事务已按 identity 清理的方式锁住 users 行时照常执行（不等锁、不另开事务），随调用方提交', async () => {
  const s = await subject(db);
  const row = await bind(db, s, { platform: 'taobao', status: 'active' });
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
    await lockUser(trx, s);
    await blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT });
    expect(await bindingsOf(trx, s)).toStrictEqual([blockedForDeletion(row)]);
    // Not committed yet: another connection still sees the active row.
    expect(await bindingsOf(db, s)).toStrictEqual([row]);
  });
  expect(await bindingsOf(db, s)).toStrictEqual([blockedForDeletion(row)]);
});

it('[AC-B1-06zc#6] 按 app_id 与用户隔离：同 App 其他用户、别的 App 的用户不受影响；同一 userId 配别的 appId 不改任何行', async () => {
  const s = await subject(db);
  const neighbour = await subject(db, { appId: s.appId, status: 'normal' });
  const elsewhere = await subject(db, { status: 'normal' });
  await everyState(db, s);
  await everyState(db, neighbour);
  await everyState(db, elsewhere);
  const mine = await bindingsOf(db, s);
  const sameApp = await bindingsOfApp(db, s.appId);
  const otherApp = await bindingsOfApp(db, elsewhere.appId);

  // The same subject with the wrong App (users.id is globally unique): nothing anywhere.
  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: elsewhere.appId, userId: s.userId, at: AT }));
  expect(await bindingsOfApp(db, s.appId)).toStrictEqual(sameApp);
  expect(await bindingsOfApp(db, elsewhere.appId)).toStrictEqual(otherApp);

  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect(await bindingsOf(db, s)).toStrictEqual(
    mine.map((row) =>
      ['active', 'invalid', 'pending_auth'].includes(row.status) ? blockedForDeletion(row) : row,
    ),
  );
  expect(await bindingsOf(db, neighbour)).toStrictEqual(
    sameApp.filter((row) => row.user_id === neighbour.userId),
  );
  expect(await bindingsOfApp(db, elsewhere.appId)).toStrictEqual(otherApp);
});

it('[AC-B1-06zc#7] 没有任何绑定的用户：调用成功、不写任何行', async () => {
  const s = await subject(db);
  const neighbour = await subject(db, { appId: s.appId, status: 'normal' });
  await bind(db, neighbour, { platform: 'taobao', status: 'active' });
  const sameApp = await bindingsOfApp(db, s.appId);
  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect(await bindingsOf(db, s)).toStrictEqual([]);
  expect(await bindingsOfApp(db, s.appId)).toStrictEqual(sameApp);
});

it('[AC-B1-06zc#8] 不动 link_logs：该用户作为点击者与分享者的打开记录按 90 天留存原样保留，不删不改', async () => {
  const s = await subject(db);
  await bind(db, s, { platform: 'taobao', status: 'active' });
  await linkLog(db, s, shift(AT, -DAY_MS));
  await linkLog(db, s, shift(AT, -30 * DAY_MS));
  const before = await linkLogsOf(db, s.appId);
  expect(before).toHaveLength(2);
  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect(await linkLogsOf(db, s.appId)).toStrictEqual(before);
  expect((await bindingsOf(db, s)).map((row) => row.blocked_reason)).toStrictEqual(['deletion']);
});

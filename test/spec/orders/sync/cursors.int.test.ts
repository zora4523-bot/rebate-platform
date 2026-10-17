import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createSyncCursorStore } from '../../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import type {
  OrderSyncWindow,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { END, NOW, START, window } from './kit.ts';

// The shared integration global setup provisions the migrated template and injects its
// factory connection. Each file clones it; queries below use the ordinary application role.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function scenario() {
  const clock = new FixedClock(NOW);
  const accountId = randomUUID();
  const appId = `sync-spec-${randomUUID()}`;
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'pdd',
      account_name: 'synthetic sync account',
      status: 'active',
      auth_status: 'active',
      sync_start_at: START,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const win: OrderSyncWindow = { ...window, app_id: appId, union_account_id: accountId };
  const stream: SyncStream = {
    app_id: appId,
    platform: 'pdd',
    union_account_id: accountId,
    query_kind: 'increment',
    scene: '-',
  };
  return { clock, win, stream };
}

async function seed(stream: SyncStream, cursor = START) {
  await db
    .insertInto('sync_cursors')
    .values({ ...stream, cursor_at: cursor, updated_at: START })
    .execute();
}

async function rows(appId: string) {
  return db
    .selectFrom('sync_cursors')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

it('[AC-B1-08g#25] 无行读取 null，首个完成窗口插入水位与注入时钟 updated_at', async () => {
  const f = await scenario();
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.read(f.stream)).toBeNull();
  expect(await store.advance(f.win)).toBe(true);
  expect(await store.read(f.stream)).toBe(END);
  expect(await rows(f.win.app_id)).toEqual([
    expect.objectContaining({
      ...f.stream,
      cursor_at: new Date(END),
      updated_at: new Date(NOW),
    }),
  ]);
});

it('[AC-B1-08g#26] 当前水位等于窗口起点才更新，重复窗口不写 updated_at', async () => {
  const f = await scenario();
  await seed(f.stream);
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.advance(f.win)).toBe(true);
  const before = await rows(f.win.app_id);
  expect(before[0]?.cursor_at).toEqual(new Date(END));
  expect(before[0]?.updated_at).toEqual(new Date(NOW));
  f.clock.advanceMs(60_000);
  expect(await store.advance(f.win)).toBe(false);
  expect(await rows(f.win.app_id)).toEqual(before);
});

it.each([
  { cursor: '2026-10-17T01:00:00.000Z', label: '旧窗口不得回退' },
  { cursor: '2026-10-16T23:30:00.000Z', label: '未来窗口不得跳过缺口' },
])('[AC-B1-08g#27] $label：不等起点的 CAS 不写任何列', async ({ cursor }) => {
  const f = await scenario();
  await seed(f.stream, cursor);
  const before = await rows(f.win.app_id);
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.advance(f.win)).toBe(false);
  expect(await rows(f.win.app_id)).toEqual(before);
});

it('[AC-B1-08g#28] 同账号 query_kind / scene 各自读写，不会批量更新其他流', async () => {
  const f = await scenario();
  const otherKind = { ...f.stream, query_kind: 'pay_time' };
  const otherScene = { ...f.stream, scene: 'synthetic-other-scene' };
  await seed(f.stream);
  // Equal cursors deliberately make missing kind/scene predicates affect the decoy rows.
  await seed(otherKind);
  await seed(otherScene);
  const before = await rows(f.win.app_id);
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.advance(f.win)).toBe(true);
  const after = await rows(f.win.app_id);
  expect(after.filter((r) => r.query_kind !== 'increment' || r.scene !== '-')).toEqual(
    before.filter((r) => r.query_kind !== 'increment' || r.scene !== '-'),
  );
  expect(await store.read(f.stream)).toBe(END);
  expect(await store.read(otherKind)).toBe(START);
  expect(await store.read(otherScene)).toBe(START);
});

it('[AC-B1-08g#29] app、platform、账号都是读取过滤条件，不能拿另一流的水位', async () => {
  const f = await scenario();
  const second = await scenario();
  await seed(f.stream);
  await seed(second.stream, END);
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.read(f.stream)).toBe(START);
  expect(await store.read(second.stream)).toBe(END);
  for (const changed of [
    { app_id: 'nonexistent-app' },
    { platform: 'jd' as const },
    { union_account_id: randomUUID() },
  ]) {
    expect(await store.read({ ...f.stream, ...changed })).toBeNull();
  }
  const otherBefore = await rows(second.win.app_id);
  expect(await store.advance(f.win)).toBe(true);
  expect(await rows(second.win.app_id)).toEqual(otherBefore);
});

it('[AC-B1-08g#30] 同 app 下多个账号及平台更新只命中目标流', async () => {
  const f = await scenario();
  await seed(f.stream);
  const streams: SyncStream[] = [];
  for (const platform of ['pdd', 'jd'] as const) {
    const id = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: f.win.app_id,
        platform,
        account_name: 'synthetic independent account',
        status: 'active',
        auth_status: 'active',
        sync_start_at: START,
      })
      .execute();
    const s = { ...f.stream, platform, union_account_id: id };
    streams.push(s);
    await seed(s);
  }
  const before = await rows(f.win.app_id);
  const store = createSyncCursorStore(db, f.clock);
  expect(await store.advance(f.win)).toBe(true);
  for (const s of streams) expect(await store.read(s)).toBe(START);
  expect(
    (await rows(f.win.app_id)).filter((r) => r.union_account_id !== f.win.union_account_id),
  ).toEqual(before.filter((r) => r.union_account_id !== f.win.union_account_id));
});

it.each([false, true])(
  '[AC-B1-08g#31] 并发重复窗口（已有水位=%s）只成功一次，无唯一冲突泄漏且只有一行',
  async (existing) => {
    const f = await scenario();
    if (existing) await seed(f.stream);
    const store = createSyncCursorStore(db, f.clock);
    const results = await Promise.all([store.advance(f.win), store.advance(f.win)]);
    expect(results.sort()).toEqual([false, true]);
    const saved = await rows(f.win.app_id);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.cursor_at).toEqual(new Date(END));
  },
);

it('[AC-B1-08g#32] 同起点不同终点竞争，败者不能覆盖胜者提交的水位', async () => {
  const f = await scenario();
  await seed(f.stream);
  const store = createSyncCursorStore(db, f.clock);
  const shorter = { ...f.win, window_end: '2026-10-17T00:15:00.000Z' };
  const results = await Promise.all([store.advance(f.win), store.advance(shorter)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await store.read(f.stream)).toBe(results[0] ? END : shorter.window_end);
  expect(await rows(f.win.app_id)).toHaveLength(1);
});

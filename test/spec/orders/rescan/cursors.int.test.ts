import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRescanCursorStore } from '../../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import type {
  OrderRescanWindow,
  RescanStream,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';

const NOW = '2026-10-17T02:00:00.000Z';
const SEEDED = '2026-10-01T00:00:00.000Z';
const CURSOR = '2026-10-17T01:30:00.000Z';
const CURSOR_END = '2026-10-17T02:30:00.000Z';
const ROUND_START = '2026-09-17T02:00:00.000Z';
const OLDER = '2026-08-01T00:00:00.000Z';

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

async function scenario(appId = `rescan-spec-${randomUUID()}`) {
  const clock = new FixedClock(NOW);
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'jd',
      account_name: `synthetic rescan account ${accountId}`,
      status: 'active',
      auth_status: 'active',
      sync_start_at: OLDER,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const stream: RescanStream = {
    app_id: appId,
    platform: 'jd',
    union_account_id: accountId,
    query_kind: 'rescan',
    scene: '-',
  };
  return { clock, stream, store: createRescanCursorStore(db, clock) };
}

async function seed(stream: SyncStream, cursor = CURSOR) {
  await db
    .insertInto('sync_cursors')
    .values({ ...stream, cursor_at: cursor, updated_at: SEEDED })
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

function windowFrom(stream: RescanStream, start: string, end: string): OrderRescanWindow {
  return { ...stream, window_start: start, window_end: end };
}

it.each([
  { label: '一轮走完回到轮首', from: CURSOR, to: ROUND_START },
  { label: '早于范围的游标前移到范围起点', from: OLDER, to: ROUND_START },
])('[AC-B1-04zm#56] $label：命中才写，updated_at 取注入时钟', async ({ from, to }) => {
  const f = await scenario();
  await seed(f.stream, from);
  expect(await f.store.rewind(f.stream, from, to)).toBe(true);
  expect(await f.store.read(f.stream)).toBe(to);
  expect(await rows(f.stream.app_id)).toEqual([
    expect.objectContaining({
      ...f.stream,
      cursor_at: new Date(to),
      updated_at: new Date(NOW),
    }),
  ]);
});

it('[AC-B1-04zm#57] 当前游标不等于 expected 时不写任何列', async () => {
  const f = await scenario();
  await seed(f.stream);
  const before = await rows(f.stream.app_id);
  f.clock.advanceMs(60_000);
  expect(await f.store.rewind(f.stream, OLDER, ROUND_START)).toBe(false);
  expect(await rows(f.stream.app_id)).toEqual(before);
});

it('[AC-B1-04zm#58] 流还没有行时不插入', async () => {
  const f = await scenario();
  expect(await f.store.rewind(f.stream, CURSOR, ROUND_START)).toBe(false);
  expect(await rows(f.stream.app_id)).toEqual([]);
});

it('[AC-B1-04zm#59] 只动目标流：同账号的 increment 流与其他 scene、其他账号和 App 都不变', async () => {
  const f = await scenario();
  const sameApp = await scenario(f.stream.app_id);
  const otherApp = await scenario();
  const increment = { ...f.stream, query_kind: 'increment' };
  const otherScene = { ...f.stream, scene: 'synthetic-other-scene' };
  await seed(f.stream);
  // Equal cursors deliberately make a missing predicate hit the decoy rows; the target is row 0.
  await seed(increment);
  await seed(otherScene);
  await seed(sameApp.stream);
  await seed(otherApp.stream);
  const before = await rows(f.stream.app_id);
  const otherBefore = await rows(otherApp.stream.app_id);
  expect(await f.store.rewind(f.stream, CURSOR, ROUND_START)).toBe(true);
  expect((await rows(f.stream.app_id)).slice(1)).toEqual(before.slice(1));
  expect(await rows(otherApp.stream.app_id)).toEqual(otherBefore);
  expect(await f.store.read(f.stream)).toBe(ROUND_START);
  expect(await f.store.read(increment)).toBe(CURSOR);
  expect(await f.store.read(sameApp.stream)).toBe(CURSOR);
});

it('[AC-B1-04zm#60] 回到轮首后窗口照常 CAS 推进；rescan 推进不动 increment 游标', async () => {
  const f = await scenario();
  const increment = { ...f.stream, query_kind: 'increment' };
  await seed(f.stream);
  await seed(increment);
  const end = '2026-09-17T03:00:00.000Z';
  expect(await f.store.rewind(f.stream, CURSOR, ROUND_START)).toBe(true);
  expect(await f.store.advance(windowFrom(f.stream, ROUND_START, end))).toBe(true);
  expect(await f.store.read(f.stream)).toBe(end);
  expect(await f.store.read(increment)).toBe(CURSOR);
});

it('[AC-B1-04zm#61] 重置前已在途的旧窗口 CAS 落空，不把游标带回原位', async () => {
  const f = await scenario();
  await seed(f.stream);
  expect(await f.store.rewind(f.stream, CURSOR, ROUND_START)).toBe(true);
  expect(await f.store.advance(windowFrom(f.stream, CURSOR, CURSOR_END))).toBe(false);
  expect(await f.store.read(f.stream)).toBe(ROUND_START);
});

it('[AC-B1-04zm#62] 回卷与推进竞争同一游标只成功一个，败者不覆盖胜者', async () => {
  const f = await scenario();
  await seed(f.stream);
  const results = await Promise.all([
    f.store.advance(windowFrom(f.stream, CURSOR, CURSOR_END)),
    f.store.rewind(f.stream, CURSOR, ROUND_START),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await f.store.read(f.stream)).toBe(results[0] ? CURSOR_END : ROUND_START);
  expect(await rows(f.stream.app_id)).toHaveLength(1);
});

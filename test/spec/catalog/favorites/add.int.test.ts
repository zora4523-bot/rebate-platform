// B1-28b: adding a favorite on a real PostgreSQL as couli_app (规划/04 §3.2 favorites, §6.3 PUT
// /v1/me/favorites/{platform}/{product_key}; orchestrator semantics B.1, B.6; 10 AC-S1-139:
// 同一商品重复收藏只有一行；第 201 条被拒). Table app.favorites comes from the merged B1-28a
// migration 0031 (db/schema.sql); every test calls the catalog API, so on the skeleton it fails
// with NotImplemented.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFavoritesService,
  FavoriteError,
  type CatalogConfigReader,
  type FavoritesService,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { countOf, newUserId, rowsOf, seedMany } from './db-kit.ts';
import { at, capConfig, cardPort, settled, warnSink } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
}, 60_000);
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
}, 60_000);

function service(
  clock: FixedClock,
  config: CatalogConfigReader = capConfig(undefined),
): FavoritesService {
  return createFavoritesService({
    db,
    clock,
    config,
    cards: cardPort(),
    logger: warnSink(),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

it('[AC-B1-28b#13] 加入：插入一行，created_at 取注入 Clock，返回记录（id、platform、product_key、收藏时间）；表里只有引用与时间', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock);
  const userId = newUserId();
  const record = await favorites.addFavorite('fav-add-1', userId, 'taobao', 'tb:1001');
  expect(record.platform).toBe('taobao');
  expect(record.productKey).toBe('tb:1001');
  expect(record.favoritedAt.getTime()).toBe(Date.parse('2031-05-20T00:00:00.000Z'));
  expect(record.id).toMatch(UUID);
  const rows = await rowsOf(db, 'fav-add-1', userId);
  expect(rows).toEqual([
    {
      id: record.id,
      app_id: 'fav-add-1',
      user_id: userId,
      platform: 'taobao',
      product_key: 'tb:1001',
      created_at: new Date('2031-05-20T00:00:00.000Z'),
    },
  ]);
  const columns = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'favorites' ORDER BY column_name
  `.execute(db);
  expect(columns.rows.map((r) => r.column_name)).toEqual([
    'app_id',
    'created_at',
    'id',
    'platform',
    'product_key',
    'user_id',
  ]);
}, 30_000);

it('[AC-B1-28b#14] 同一商品重复收藏只有一行：再次加入返回原记录（原 id、原收藏时间），不新增、不改时间', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock);
  const userId = newUserId();
  const first = await favorites.addFavorite('fav-add-2', userId, 'taobao', 'tb:1002');
  clock.set(at('09:30'));
  const second = await favorites.addFavorite('fav-add-2', userId, 'taobao', 'tb:1002');
  clock.set(at('11:00'));
  const third = await favorites.addFavorite('fav-add-2', userId, 'taobao', 'tb:1002');
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect(second.favoritedAt.getTime()).toBe(Date.parse('2031-05-20T00:00:00.000Z'));
  const rows = await rowsOf(db, 'fav-add-2', userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.created_at).toEqual(new Date('2031-05-20T00:00:00.000Z'));
  expect(rows[0]?.id).toBe(first.id);
}, 30_000);

it('[AC-B1-28b#15] 唯一键是 (app_id, user_id, platform, product_key)：别的用户、别的 app、别的平台各自一行', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock);
  const userA = newUserId();
  const userB = newUserId();
  await favorites.addFavorite('fav-add-3', userA, 'taobao', 'tb:1003');
  await favorites.addFavorite('fav-add-3', userB, 'taobao', 'tb:1003');
  await favorites.addFavorite('fav-add-3b', userA, 'taobao', 'tb:1003');
  await favorites.addFavorite('fav-add-3', userA, 'jd', 'tb:1003');
  expect(await countOf(db, 'fav-add-3', userA)).toBe(2);
  expect(await countOf(db, 'fav-add-3', userB)).toBe(1);
  expect(await countOf(db, 'fav-add-3b', userA)).toBe(1);
}, 30_000);

it('[AC-B1-28b#16] 第 201 条被拒（默认上限 200）：已有 199 条时第 200 条成功，再加第 201 条 → 20001 favorites_full，不落库', async () => {
  const clock = new FixedClock(at('12:00'));
  const favorites = service(clock);
  const userId = newUserId();
  await seedMany(db, 'fav-cap-default', userId, 199, at('10:00'));
  const added = await settled(() =>
    favorites.addFavorite('fav-cap-default', userId, 'taobao', 'tb:the-200th'),
  );
  expect(added).toMatchObject({ kind: 'returned', value: { productKey: 'tb:the-200th' } });
  const denied = await settled(() =>
    favorites.addFavorite('fav-cap-default', userId, 'taobao', 'tb:the-201st'),
  );
  expect(denied).toMatchObject({
    kind: 'rejected',
    error: { code: 20001, data: { reason: 'favorites_full' } },
  });
  expect(denied.kind === 'rejected' && denied.error instanceof FavoriteError).toBe(true);
  expect(await countOf(db, 'fav-cap-default', userId)).toBe(200);
  const keys = (await rowsOf(db, 'fav-cap-default', userId)).map((r) => r.product_key);
  expect(keys).not.toContain('tb:the-201st');
}, 60_000);

it('[AC-B1-28b#17] 上限可配：favorites.max_per_user=3 → 第 4 条 20001 favorites_full；读配置用本 app', async () => {
  const clock = new FixedClock(at('08:00'));
  const config = capConfig(3, { appId: 'fav-cap-3' });
  const favorites = service(clock, config);
  const userId = newUserId();
  for (const key of ['tb:c1', 'tb:c2', 'tb:c3']) {
    await favorites.addFavorite('fav-cap-3', userId, 'taobao', key);
    clock.advanceMs(1_000);
  }
  const denied = await settled(() => favorites.addFavorite('fav-cap-3', userId, 'taobao', 'tb:c4'));
  expect(denied).toMatchObject({
    kind: 'rejected',
    error: { code: 20001, data: { reason: 'favorites_full' } },
  });
  expect(await countOf(db, 'fav-cap-3', userId)).toBe(3);
  expect(config.calls).toContainEqual(['fav-cap-3', 'favorites.max_per_user']);
}, 30_000);

it('[AC-B1-28b#18] 满额时重复加入已有商品仍返回原记录（先判已存在，再判上限）', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock, capConfig(2));
  const userId = newUserId();
  const first = await favorites.addFavorite('fav-cap-again', userId, 'taobao', 'tb:a1');
  clock.advanceMs(1_000);
  await favorites.addFavorite('fav-cap-again', userId, 'taobao', 'tb:a2');
  clock.advanceMs(1_000);
  const again = await settled(() =>
    favorites.addFavorite('fav-cap-again', userId, 'taobao', 'tb:a1'),
  );
  expect(again).toEqual({ kind: 'returned', value: first });
  expect(await countOf(db, 'fav-cap-again', userId)).toBe(2);
}, 30_000);

it('[AC-B1-28b#19] 删除一条后可再加一条：上限按当前条数计', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock, capConfig(2));
  const userId = newUserId();
  await favorites.addFavorite('fav-cap-free', userId, 'taobao', 'tb:f1');
  await favorites.addFavorite('fav-cap-free', userId, 'taobao', 'tb:f2');
  await favorites.removeFavorite('fav-cap-free', userId, 'taobao', 'tb:f1');
  const added = await settled(() =>
    favorites.addFavorite('fav-cap-free', userId, 'taobao', 'tb:f3'),
  );
  expect(added).toMatchObject({ kind: 'returned', value: { productKey: 'tb:f3' } });
  expect(await countOf(db, 'fav-cap-free', userId)).toBe(2);
}, 30_000);

it('[AC-B1-28b#20] 上限只数本 app 本用户：同一用户在别的 app 有 3 条、别的用户在本 app 有 3 条，不影响本人加入', async () => {
  const clock = new FixedClock(at('12:00'));
  const favorites = service(clock, capConfig(3));
  const userId = newUserId();
  const other = newUserId();
  await seedMany(db, 'fav-cap-scope-b', userId, 3, at('10:00'));
  await seedMany(db, 'fav-cap-scope-a', other, 3, at('10:00'));
  const added = await settled(() =>
    favorites.addFavorite('fav-cap-scope-a', userId, 'taobao', 'tb:mine'),
  );
  expect(added).toMatchObject({ kind: 'returned', value: { productKey: 'tb:mine' } });
  expect(await countOf(db, 'fav-cap-scope-a', userId)).toBe(1);
}, 30_000);

it('[AC-B1-28b#21] 并发加入第 200 / 201 条（默认上限）：恰好一条成功一条 favorites_full，总数 200；重复 5 轮', async () => {
  const clock = new FixedClock(at('12:00'));
  const favorites = service(clock);
  for (let round = 1; round <= 5; round += 1) {
    const userId = newUserId();
    await seedMany(db, 'fav-race-200', userId, 199, at('10:00'));
    const results = await Promise.all(
      ['tb:race-x', 'tb:race-y'].map((key) =>
        settled(() => favorites.addFavorite('fav-race-200', userId, 'taobao', key)),
      ),
    );
    expect(results.filter((r) => r.kind === 'returned')).toHaveLength(1);
    const rejected = results.filter((r) => r.kind === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      error: { code: 20001, data: { reason: 'favorites_full' } },
    });
    expect(await countOf(db, 'fav-race-200', userId)).toBe(200);
  }
}, 180_000);

it('[AC-B1-28b#22] 并发加入（上限配 3、已有 2 条）：6 个不同商品同时加入，恰好 1 条成功、5 条 favorites_full；重复 10 轮', async () => {
  const clock = new FixedClock(at('12:00'));
  const favorites = service(clock, capConfig(3));
  for (let round = 1; round <= 10; round += 1) {
    const userId = newUserId();
    await seedMany(db, 'fav-race-3', userId, 2, at('10:00'));
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        settled(() => favorites.addFavorite('fav-race-3', userId, 'taobao', `tb:r${n}`)),
      ),
    );
    expect(results.filter((r) => r.kind === 'returned')).toHaveLength(1);
    const rejected = results.filter((r) => r.kind === 'rejected');
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect(r).toMatchObject({ error: { code: 20001, data: { reason: 'favorites_full' } } });
    }
    expect(await countOf(db, 'fav-race-3', userId)).toBe(3);
  }
}, 180_000);

it('[AC-B1-28b#23] 同一商品并发加入 8 次：都成功、都返回同一条记录（同 id 同时间），表里只有一行；重复 5 轮', async () => {
  const clock = new FixedClock(at('08:00'));
  const favorites = service(clock);
  for (let round = 1; round <= 5; round += 1) {
    const userId = newUserId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        settled(() => favorites.addFavorite('fav-race-same', userId, 'taobao', 'tb:same')),
      ),
    );
    const returned = results.filter((r) => r.kind === 'returned');
    expect(returned).toHaveLength(8);
    const rows = await rowsOf(db, 'fav-race-same', userId);
    expect(rows).toHaveLength(1);
    for (const r of returned) {
      expect(r.value.id).toBe(rows[0]?.id);
      expect(r.value.favoritedAt.getTime()).toBe(rows[0]?.created_at.getTime());
    }
  }
}, 120_000);

it('[AC-B1-28b#24] 不同用户互不串行阻塞：两个用户各自已满，同时加入都被拒；各自未满同时加入都成功', async () => {
  const clock = new FixedClock(at('12:00'));
  const favorites = service(clock, capConfig(1));
  const full1 = newUserId();
  const full2 = newUserId();
  await seedMany(db, 'fav-race-users', full1, 1, at('10:00'));
  await seedMany(db, 'fav-race-users', full2, 1, at('10:00'));
  const denied = await Promise.all(
    [full1, full2].map((u) =>
      settled(() => favorites.addFavorite('fav-race-users', u, 'taobao', 'tb:u')),
    ),
  );
  expect(denied.map((r) => r.kind)).toEqual(['rejected', 'rejected']);
  const free1 = newUserId();
  const free2 = newUserId();
  const ok = await Promise.all(
    [free1, free2].map((u) =>
      settled(() => favorites.addFavorite('fav-race-users', u, 'taobao', 'tb:u')),
    ),
  );
  expect(ok.map((r) => r.kind)).toEqual(['returned', 'returned']);
  expect(await countOf(db, 'fav-race-users', free1)).toBe(1);
  expect(await countOf(db, 'fav-race-users', free2)).toBe(1);
}, 60_000);

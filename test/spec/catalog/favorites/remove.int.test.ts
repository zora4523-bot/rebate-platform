// B1-28b: removing favorites, the favorited check and deletion with the account, on a real
// PostgreSQL as couli_app (规划/04 §6.3 DELETE /v1/me/favorites/{platform}/{product_key} and POST
// /v1/me/favorites/batch-delete: 取消收藏不存在也返回成功，批量最多 100 项；商品详情 favorited
// 未登录为 false; 04 §3.2 favorites and BR-ID-30 ⑱: 用户删除即物理删除，注销完成时随账号删除;
// orchestrator semantics B.2, B.4, B.5).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFavoritesService,
  FavoriteError,
  type FavoriteKey,
  type FavoritesService,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { countOf, newUserId, rowsOf, seedMany, seedOne } from './db-kit.ts';
import { at, capConfig, cardPort, settled, warnSink } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 60_000);
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
}, 60_000);

function service(): FavoritesService {
  return createFavoritesService({
    db,
    clock: new FixedClock(at('12:00')),
    config: capConfig(undefined),
    cards: cardPort(),
    logger: warnSink(),
  });
}

it('[AC-B1-28b#25] 取消收藏：物理删除该行，只删本人本 app 这一条', async () => {
  const favorites = service();
  const userId = newUserId();
  const other = newUserId();
  await seedOne(db, { appId: 'fav-rm-1', userId, productKey: 'tb:2001', createdAt: at('08:00') });
  await seedOne(db, { appId: 'fav-rm-1', userId, productKey: 'tb:2002', createdAt: at('08:01') });
  await seedOne(db, {
    appId: 'fav-rm-1',
    userId: other,
    productKey: 'tb:2001',
    createdAt: at('08:00'),
  });
  await seedOne(db, { appId: 'fav-rm-1b', userId, productKey: 'tb:2001', createdAt: at('08:00') });
  await favorites.removeFavorite('fav-rm-1', userId, 'taobao', 'tb:2001');
  expect((await rowsOf(db, 'fav-rm-1', userId)).map((r) => r.product_key)).toEqual(['tb:2002']);
  expect(await countOf(db, 'fav-rm-1', other)).toBe(1);
  expect(await countOf(db, 'fav-rm-1b', userId)).toBe(1);
}, 30_000);

it('[AC-B1-28b#26] 取消不存在的收藏也成功（幂等），连续取消两次都成功', async () => {
  const favorites = service();
  const userId = newUserId();
  await seedOne(db, { appId: 'fav-rm-2', userId, productKey: 'tb:2101', createdAt: at('08:00') });
  await expect(
    favorites.removeFavorite('fav-rm-2', userId, 'taobao', 'tb:never'),
  ).resolves.toBeUndefined();
  await expect(
    favorites.removeFavorite('fav-rm-2', userId, 'taobao', 'tb:2101'),
  ).resolves.toBeUndefined();
  await expect(
    favorites.removeFavorite('fav-rm-2', userId, 'taobao', 'tb:2101'),
  ).resolves.toBeUndefined();
  expect(await countOf(db, 'fav-rm-2', userId)).toBe(0);
}, 30_000);

it('[AC-B1-28b#27] 平台也是键的一部分：取消 jd 的同名 key 不删 taobao 那一行', async () => {
  const favorites = service();
  const userId = newUserId();
  await seedOne(db, { appId: 'fav-rm-3', userId, productKey: 'tb:2201', createdAt: at('08:00') });
  await favorites.removeFavorite('fav-rm-3', userId, 'jd', 'tb:2201');
  expect(await countOf(db, 'fav-rm-3', userId)).toBe(1);
}, 30_000);

it('[AC-B1-28b#28] 批量删除：逐项删除本人的，不存在的忽略，别人的同一商品不动', async () => {
  const favorites = service();
  const userId = newUserId();
  const other = newUserId();
  for (const [i, key] of ['tb:b1', 'tb:b2', 'tb:b3', 'tb:b4'].entries()) {
    await seedOne(db, { appId: 'fav-batch-1', userId, productKey: key, createdAt: at(`08:0${i}`) });
  }
  await seedOne(db, {
    appId: 'fav-batch-1',
    userId: other,
    productKey: 'tb:b1',
    createdAt: at('08:00'),
  });
  await favorites.removeFavorites('fav-batch-1', userId, [
    { platform: 'taobao', productKey: 'tb:b1' },
    { platform: 'taobao', productKey: 'tb:missing' },
    { platform: 'taobao', productKey: 'tb:b3' },
    { platform: 'taobao', productKey: 'tb:b3' },
    { platform: 'jd', productKey: 'tb:b4' },
  ]);
  expect((await rowsOf(db, 'fav-batch-1', userId)).map((r) => r.product_key)).toEqual([
    'tb:b4',
    'tb:b2',
  ]);
  expect(await countOf(db, 'fav-batch-1', other)).toBe(1);
}, 30_000);

function itemsOf(n: number): FavoriteKey[] {
  return Array.from({ length: n }, (_, i) => ({
    platform: 'taobao',
    productKey: `tb:seed-${i + 1}`,
  }));
}

it('[AC-B1-28b#29] 批量删除恰好 100 项可以：100 项全删', async () => {
  const favorites = service();
  const userId = newUserId();
  await seedMany(db, 'fav-batch-100', userId, 105, at('10:00'));
  await favorites.removeFavorites('fav-batch-100', userId, itemsOf(100));
  const left = (await rowsOf(db, 'fav-batch-100', userId)).map((r) => r.product_key);
  expect(left).toEqual(['tb:seed-101', 'tb:seed-102', 'tb:seed-103', 'tb:seed-104', 'tb:seed-105']);
}, 30_000);

it('[AC-B1-28b#30] 批量删除 101 项 → 20001（data.fields 指 items），一条都不删', async () => {
  const favorites = service();
  const userId = newUserId();
  await seedMany(db, 'fav-batch-101', userId, 105, at('10:00'));
  const denied = await settled(() =>
    favorites.removeFavorites('fav-batch-101', userId, itemsOf(101)),
  );
  expect(denied).toMatchObject({
    kind: 'rejected',
    error: { code: 20001, data: { fields: ['items'] } },
  });
  expect(denied.kind === 'rejected' && denied.error instanceof FavoriteError).toBe(true);
  expect(await countOf(db, 'fav-batch-101', userId)).toBe(105);
}, 30_000);

it('[AC-B1-28b#31] 是否已收藏：本人本 app 有 → true；别的用户、别的 app、别的平台、已取消 → false', async () => {
  const favorites = service();
  const userId = newUserId();
  const other = newUserId();
  await seedOne(db, { appId: 'fav-is-1', userId, productKey: 'tb:3001', createdAt: at('08:00') });
  await seedOne(db, { appId: 'fav-is-1', userId, productKey: 'tb:3002', createdAt: at('08:01') });
  expect(await favorites.isFavorited('fav-is-1', userId, 'taobao', 'tb:3001')).toBe(true);
  expect(await favorites.isFavorited('fav-is-1', other, 'taobao', 'tb:3001')).toBe(false);
  expect(await favorites.isFavorited('fav-is-1b', userId, 'taobao', 'tb:3001')).toBe(false);
  expect(await favorites.isFavorited('fav-is-1', userId, 'jd', 'tb:3001')).toBe(false);
  expect(await favorites.isFavorited('fav-is-1', userId, 'taobao', 'tb:never')).toBe(false);
  await favorites.removeFavorite('fav-is-1', userId, 'taobao', 'tb:3002');
  expect(await favorites.isFavorited('fav-is-1', userId, 'taobao', 'tb:3002')).toBe(false);
}, 30_000);

it('[AC-B1-28b#32] 未登录（userId 为 null）→ isFavorited 为 false', async () => {
  const favorites = service();
  await expect(favorites.isFavorited('fav-is-guest', null, 'taobao', 'tb:3101')).resolves.toBe(
    false,
  );
}, 30_000);

it('[AC-B1-28b#33] 加入后 isFavorited 为 true（同一服务实例写读一致）', async () => {
  const favorites = service();
  const userId = newUserId();
  await favorites.addFavorite('fav-is-2', userId, 'taobao', 'tb:3201');
  expect(await favorites.isFavorited('fav-is-2', userId, 'taobao', 'tb:3201')).toBe(true);
}, 30_000);

it('[AC-B1-28b#34] 注销完成：deleteAllFavoritesOfUser 物理删除该用户在本 app 的全部收藏，别的用户与别的 app 不动', async () => {
  const favorites = service();
  const userId = newUserId();
  const other = newUserId();
  await seedMany(db, 'fav-close-1', userId, 230, at('10:00'));
  await seedMany(db, 'fav-close-1', other, 3, at('10:00'));
  await seedMany(db, 'fav-close-1b', userId, 2, at('10:00'));
  await favorites.deleteAllFavoritesOfUser('fav-close-1', userId);
  expect(await countOf(db, 'fav-close-1', userId)).toBe(0);
  expect(await countOf(db, 'fav-close-1', other)).toBe(3);
  expect(await countOf(db, 'fav-close-1b', userId)).toBe(2);
  await expect(favorites.deleteAllFavoritesOfUser('fav-close-1', userId)).resolves.toBeUndefined();
}, 30_000);

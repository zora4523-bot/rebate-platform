// B1-28b: the favorites list on a real PostgreSQL as couli_app (规划/04 §6.3 GET
// /v1/me/favorites: 参数 cursor；按收藏时间倒序；每项 platform、product_key、favorited_at、invalid、
// product_card，invalid=true 时只含标题与图，不含价格与 rebate_*; 10 AC-S1-139; orchestrator
// semantics B.3: created_at DESC, id DESC, keyset cursor, page size 20, a card port failure makes
// only that item invalid). Cards come from a stand-in port, never a union.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFavoritesService,
  type FavoriteCardOutcome,
  type FavoriteListItem,
  type FavoritesService,
  type FavoritesViewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { newUserId, rowsOf, seedMany, seedOne } from './db-kit.ts';
import { at, capConfig, cardPort, pricedCard, settled, warnSink } from './kit.ts';

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

function setup(
  answers: ReadonlyMap<string, FavoriteCardOutcome> = new Map(),
  throws: ReadonlySet<string> = new Set(),
): {
  favorites: FavoritesService;
  port: ReturnType<typeof cardPort>;
  log: ReturnType<typeof warnSink>;
} {
  const port = cardPort(answers, throws);
  const log = warnSink();
  const favorites = createFavoritesService({
    db,
    clock: new FixedClock(at('12:00')),
    config: capConfig(undefined),
    cards: port,
    logger: log,
  });
  return { favorites, port, log };
}

function viewer(appId: string, userId: string): FavoritesViewer {
  return { appId, userId, deviceId: null };
}

/** Walks every page from the first; fails the test after 30 pages. */
async function allPages(
  favorites: FavoritesService,
  who: FavoritesViewer,
): Promise<{ sizes: number[]; items: FavoriteListItem[]; lastCursor: string | null }> {
  const sizes: number[] = [];
  const items: FavoriteListItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const result = await favorites.listFavorites(who, cursor);
    sizes.push(result.items.length);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  return { sizes, items, lastCursor: cursor };
}

it('[AC-B1-28b#35] 按收藏时间倒序；每项 platform、productKey、favoritedAt、invalid、productCard', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  await seedOne(db, { appId: 'fav-list-1', userId, productKey: 'tb:old', createdAt: at('08:00') });
  await seedOne(db, { appId: 'fav-list-1', userId, productKey: 'tb:new', createdAt: at('09:00') });
  await seedOne(db, {
    appId: 'fav-list-1',
    userId,
    platform: 'jd',
    productKey: 'jd:mid',
    createdAt: at('08:30'),
  });
  const page = await favorites.listFavorites(viewer('fav-list-1', userId), null);
  expect(page.items.map((i) => i.productKey)).toEqual(['tb:new', 'jd:mid', 'tb:old']);
  expect(page.items[0]).toEqual({
    platform: 'taobao',
    productKey: 'tb:new',
    favoritedAt: new Date('2031-05-20T01:00:00.000Z'),
    invalid: false,
    productCard: pricedCard('tb:new'),
  });
  expect(page.items[1]?.platform).toBe('jd');
  expect(page.nextCursor).toBeNull();
}, 30_000);

it('[AC-B1-28b#36] 只列本人本 app 的收藏；没有收藏 → 空页、nextCursor 为 null', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  const other = newUserId();
  await seedOne(db, {
    appId: 'fav-list-2',
    userId: other,
    productKey: 'tb:theirs',
    createdAt: at('08:00'),
  });
  await seedOne(db, {
    appId: 'fav-list-2b',
    userId,
    productKey: 'tb:elsewhere',
    createdAt: at('08:00'),
  });
  const empty = await favorites.listFavorites(viewer('fav-list-2', userId), null);
  expect(empty).toEqual({ items: [], nextCursor: null });
  await seedOne(db, { appId: 'fav-list-2', userId, productKey: 'tb:mine', createdAt: at('08:00') });
  const one = await favorites.listFavorites(viewer('fav-list-2', userId), null);
  expect(one.items.map((i) => i.productKey)).toEqual(['tb:mine']);
}, 30_000);

it('[AC-B1-28b#37] 每页 20：45 条分 20、20、5 三页，顺序与库里 (created_at DESC, id DESC) 一致、不重不漏，最后一页 nextCursor 为 null', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  await seedMany(db, 'fav-page-45', userId, 45, at('10:00'));
  const { sizes, items, lastCursor } = await allPages(favorites, viewer('fav-page-45', userId));
  expect(sizes).toEqual([20, 20, 5]);
  expect(lastCursor).toBeNull();
  const expected = Array.from({ length: 45 }, (_, i) => `tb:seed-${i + 1}`);
  expect(items.map((i) => i.productKey)).toEqual(expected);
}, 60_000);

it('[AC-B1-28b#38] 恰好 20 条：一页取完，nextCursor 为 null', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  await seedMany(db, 'fav-page-20', userId, 20, at('10:00'));
  const page = await favorites.listFavorites(viewer('fav-page-20', userId), null);
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeNull();
}, 30_000);

it('[AC-B1-28b#39] 收藏时间相同按 id 倒序：25 条同一时刻分 20、5 两页，跨页不重不漏', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  for (let i = 1; i <= 25; i += 1) {
    await seedOne(db, {
      appId: 'fav-page-tie',
      userId,
      productKey: `tb:tie-${i}`,
      createdAt: at('09:00'),
    });
  }
  const expectedIds = (await rowsOf(db, 'fav-page-tie', userId)).map((r) => r.id);
  const sortedDesc = [...expectedIds].sort().reverse();
  expect(expectedIds).toEqual(sortedDesc);
  const { sizes, items } = await allPages(favorites, viewer('fav-page-tie', userId));
  expect(sizes).toEqual([20, 5]);
  const byKey = new Map(
    (await rowsOf(db, 'fav-page-tie', userId)).map((r) => [r.product_key, r.id]),
  );
  expect(items.map((i) => byKey.get(i.productKey))).toEqual(sortedDesc);
}, 60_000);

it('[AC-B1-28b#40] 键集游标：翻页途中新加的收藏不挤进后一页，后一页不重复前一页的项', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  await seedMany(db, 'fav-page-shift', userId, 30, at('10:00'));
  const who = viewer('fav-page-shift', userId);
  const first = await favorites.listFavorites(who, null);
  expect(first.items).toHaveLength(20);
  await seedOne(db, {
    appId: 'fav-page-shift',
    userId,
    productKey: 'tb:newest',
    createdAt: at('11:00'),
  });
  const second = await favorites.listFavorites(who, first.nextCursor);
  expect(second.items.map((i) => i.productKey)).toEqual(
    Array.from({ length: 10 }, (_, i) => `tb:seed-${i + 21}`),
  );
  expect(second.nextCursor).toBeNull();
}, 30_000);

it('[AC-B1-28b#41] 不是本编码产生的游标 → 20001，不查卡', async () => {
  const { favorites, port } = setup();
  const userId = newUserId();
  await seedOne(db, { appId: 'fav-page-bad', userId, productKey: 'tb:x', createdAt: at('08:00') });
  const denied = await settled(() =>
    favorites.listFavorites(viewer('fav-page-bad', userId), 'not-a-cursor'),
  );
  expect(denied).toMatchObject({ kind: 'rejected', error: { code: 20001 } });
  expect(port.requests).toHaveLength(0);
}, 30_000);

it('[AC-B1-28b#42] 失效商品 invalid=true 且无价格与 rebate_*：联盟不存在 / 已下架 / 不可推广 → 卡只含 title 与 image', async () => {
  const answers = new Map<string, FavoriteCardOutcome>([
    ['tb:gone', { kind: 'unavailable', reason: 'not_found', title: null, image: null }],
    [
      'tb:off',
      {
        kind: 'unavailable',
        reason: 'off_shelf',
        title: '下架了',
        image: 'https://example.com/off.png',
      },
    ],
    [
      'tb:nopromo',
      { kind: 'unavailable', reason: 'not_promotable', title: '不可推广', image: null },
    ],
  ]);
  const { favorites } = setup(answers);
  const userId = newUserId();
  await seedOne(db, {
    appId: 'fav-invalid-1',
    userId,
    productKey: 'tb:gone',
    createdAt: at('08:03'),
  });
  await seedOne(db, {
    appId: 'fav-invalid-1',
    userId,
    productKey: 'tb:off',
    createdAt: at('08:02'),
  });
  await seedOne(db, {
    appId: 'fav-invalid-1',
    userId,
    productKey: 'tb:nopromo',
    createdAt: at('08:01'),
  });
  await seedOne(db, {
    appId: 'fav-invalid-1',
    userId,
    productKey: 'tb:fine',
    createdAt: at('08:00'),
  });
  const page = await favorites.listFavorites(viewer('fav-invalid-1', userId), null);
  expect(page.items.map((i) => [i.productKey, i.invalid])).toEqual([
    ['tb:gone', true],
    ['tb:off', true],
    ['tb:nopromo', true],
    ['tb:fine', false],
  ]);
  expect(page.items.map((i) => i.productCard)).toEqual([
    { title: null, image: null },
    { title: '下架了', image: 'https://example.com/off.png' },
    { title: '不可推广', image: null },
    pricedCard('tb:fine'),
  ]);
  for (const item of page.items.slice(0, 3)) {
    const keys = Object.keys(item.productCard);
    expect(keys.sort()).toEqual(['image', 'title']);
    expect(keys.some((k) => k.startsWith('rebate_') || k.endsWith('_fen'))).toBe(false);
  }
}, 30_000);

it('[AC-B1-28b#43] 取卡端口抛错：整页不失败，该项 invalid=true（卡 { title: null, image: null }），记一条日志；其余项正常', async () => {
  const { favorites, log } = setup(new Map(), new Set(['tb:boom']));
  const userId = newUserId();
  await seedOne(db, {
    appId: 'fav-invalid-2',
    userId,
    productKey: 'tb:ok-1',
    createdAt: at('08:02'),
  });
  await seedOne(db, {
    appId: 'fav-invalid-2',
    userId,
    productKey: 'tb:boom',
    createdAt: at('08:01'),
  });
  await seedOne(db, {
    appId: 'fav-invalid-2',
    userId,
    productKey: 'tb:ok-2',
    createdAt: at('08:00'),
  });
  const result = await settled(() =>
    favorites.listFavorites(viewer('fav-invalid-2', userId), null),
  );
  expect(result.kind).toBe('returned');
  const items = result.kind === 'returned' ? result.value.items : [];
  expect(items.map((i) => [i.productKey, i.invalid])).toEqual([
    ['tb:ok-1', false],
    ['tb:boom', true],
    ['tb:ok-2', false],
  ]);
  expect(items[1]?.productCard).toEqual({ title: null, image: null });
  expect(log.calls.length).toBeGreaterThanOrEqual(1);
}, 30_000);

it('[AC-B1-28b#44] 取卡按每项的平台与 product_key、带当前用户（app、user、device）调用端口，只查本页的项', async () => {
  const { favorites, port } = setup();
  const userId = newUserId();
  await seedMany(db, 'fav-card-req', userId, 23, at('10:00'));
  await seedOne(db, {
    appId: 'fav-card-req',
    userId,
    platform: 'jd',
    productKey: 'jd:top',
    createdAt: at('11:00'),
  });
  const who: FavoritesViewer = { appId: 'fav-card-req', userId, deviceId: 'fav-device-1' };
  await favorites.listFavorites(who, null);
  expect(port.requests).toHaveLength(20);
  expect(port.requests).toContainEqual({
    viewer: { appId: 'fav-card-req', userId, deviceId: 'fav-device-1' },
    platform: 'jd',
    productKey: 'jd:top',
  });
  const keys = port.requests.map((r) => r.productKey).sort();
  const expected = ['jd:top', ...Array.from({ length: 19 }, (_, i) => `tb:seed-${i + 1}`)].sort();
  expect(keys).toEqual(expected);
}, 30_000);

it('[AC-B1-28b#45] 列表项的收藏时间就是加入时 Clock 的时刻（加入后再列表）', async () => {
  const { favorites } = setup();
  const userId = newUserId();
  const added = await favorites.addFavorite('fav-list-time', userId, 'taobao', 'tb:t1');
  const page = await favorites.listFavorites(viewer('fav-list-time', userId), null);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.favoritedAt.getTime()).toBe(Date.parse('2031-05-20T04:00:00.000Z'));
  expect(added.favoritedAt.getTime()).toBe(Date.parse('2031-05-20T04:00:00.000Z'));
}, 30_000);

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/index.ts';
import { enabled, instant, reference, setup, START, stored } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it('[AC-B1-05c#1] BR-PROD-05 四种来源的原串逐字保存，包含前导零、空白、大小写和长串', async () => {
  const { catalog } = setup(db);
  const cases = [
    ['taobao', 'tb:K1', ' 000-X-K1 ', 'search'],
    ['jd', 'jd:i_AbC', '000_AbC_tail', 'detail'],
    ['jd', 'jd:000123', '000123', 'parse'],
    ['pdd', 'pdd:123', ` Ab+/%=_${'签'.repeat(3000)} `, 'pool'],
  ] as const;
  for (const [platform, productKey, rawItemId, source] of cases) {
    const ref = reference({ appId: `raw-${source}`, platform, productKey, rawItemId, source });
    await catalog.registerProductRef(ref, enabled);
    expect(await catalog.readProductRef(ref)).toEqual(ref);
    expect(await stored(db, ref.appId, productKey)).toMatchObject([
      { raw_item_id: rawItemId, source },
    ]);
  }
});

it('[AC-B1-05c#2] BR-PROD-05 refreshed_at 取响应接收时刻，不用排队后的写入时刻或原串取得时刻', async () => {
  const { catalog, clock } = setup(db);
  const ref = reference({ appId: 'receipt', rawFetchedAt: instant(-60_000) });
  clock.advanceMs(120_000);
  await catalog.registerProductRef(ref, enabled);
  expect(await stored(db, ref.appId, ref.productKey)).toMatchObject([
    {
      refreshed_at: new Date(START),
      raw_fetched_at: new Date(instant(-60_000)),
    },
  ]);
});

it('[AC-B1-05c#3] BR-PROD-05 较旧或同刻响应不得覆盖更新记录的任何字段', async () => {
  const { catalog, clock } = setup(db);
  clock.advanceMs(10_000);
  const current = reference({
    appId: 'conditional',
    rawItemId: 'NEW-K1',
    receivedAt: instant(10_000),
    title: '新标题',
    shopType: 'tmall',
  });
  await catalog.registerProductRef(current, enabled);
  for (const receivedAt of [instant(9_999), instant(10_000)]) {
    await catalog.registerProductRef(
      reference({
        appId: current.appId,
        receivedAt,
        rawItemId: 'OLD-K1',
        title: '旧标题',
        source: 'detail',
        shopId: 'old-shop',
      }),
      enabled,
    );
    expect(await catalog.readProductRef(current)).toEqual(current);
    expect(await stored(db, current.appId, current.productKey)).toMatchObject([
      {
        raw_item_id: 'NEW-K1',
        title: '新标题',
        shop_type: 'tmall',
        shop_id: 'shop-a',
        source: 'search',
      },
    ]);
  }
});

it('[AC-B1-05c#4] BR-PROD-05 多实例乱序并发登记最终只留最新响应，依赖数据库条件更新', async () => {
  const firstContext = setup(db);
  const secondContext = setup(db);
  firstContext.clock.advanceMs(10);
  secondContext.clock.advanceMs(10);
  const first = firstContext.catalog;
  const second = secondContext.catalog;
  const versions = [7, 1, 9, 2, 8, 4, 3, 6, 5, 0];
  await Promise.all(
    versions.map((version, i) =>
      (i % 2 === 0 ? first : second).registerProductRef(
        reference({
          appId: 'concurrent',
          rawItemId: `v${version}-K1`,
          receivedAt: instant(version),
          title: `标题${version}`,
        }),
        enabled,
      ),
    ),
  );
  expect(await stored(db, 'concurrent', 'tb:K1')).toMatchObject([
    {
      raw_item_id: 'v9-K1',
      title: '标题9',
      refreshed_at: new Date(instant(9)),
    },
  ]);
});

it('[AC-B1-05c#5] BR-PROD-01 商品引用按 app_id 隔离，并区分 product_key 大小写', async () => {
  const { catalog } = setup(db);
  const rows = [
    reference({ appId: 'scope-a', rawItemId: 'A-K1' }),
    reference({ appId: 'scope-b', rawItemId: 'B-K1' }),
    reference({ appId: 'scope-a', productKey: 'tb:k1', rawItemId: 'A-k1' }),
  ];
  for (const row of rows) await catalog.registerProductRef(row, enabled);
  for (const row of rows) expect(await catalog.readProductRef(row)).toEqual(row);
  expect(await catalog.readProductRef(reference({ appId: 'scope-absent' }))).toBeNull();
  expect(await catalog.readProductRef(reference({ appId: 'scope-a', platform: 'jd' }))).toBeNull();
});

it('[AC-B1-05c#6] BR-PROD-05 拒绝订单或其他未授权来源，既不新增也不覆盖', async () => {
  const { catalog } = setup(db);
  const existing = reference({ appId: 'source-existing' });
  await catalog.registerProductRef(existing, enabled);
  for (const source of ['order', 'order_sync', '', 'SEARCH']) {
    for (const appId of ['source-existing', 'source-absent']) {
      const invalid = { ...existing, appId, source } as ProductRef;
      await expect(catalog.registerProductRef(invalid, enabled)).rejects.toThrow();
    }
  }
  expect(await stored(db, 'source-absent', 'tb:K1')).toEqual([]);
  expect(await catalog.readProductRef(existing)).toEqual(existing);
});

it('[AC-B1-05c#7] BR-PROD-10 天猫仍登记 taobao / tb，保留 shop_type=tmall', async () => {
  const { catalog } = setup(db);
  const ref = reference({
    appId: 'tmall',
    shopType: 'tmall',
    source: 'parse',
    canonicalUrl: 'https://detail.tmall.com/item.htm?id=123',
  });
  await catalog.registerProductRef(ref, enabled);
  expect(await stored(db, 'tmall', 'tb:K1')).toMatchObject([
    {
      platform: 'taobao',
      product_key: 'tb:K1',
      shop_type: 'tmall',
      canonical_url: ref.canonicalUrl,
    },
  ]);
});

it('[AC-B1-05c#8] BR-PROD-10 两种能力均关闭时返回 30131 且不写入引用', async () => {
  const { catalog } = setup(db);
  const ref = reference({ appId: 'disabled' });
  await expect(
    catalog.registerProductRef(ref, { parseEnabled: false, searchEnabled: false }),
  ).rejects.toMatchObject({ code: 30131 });
  expect(await stored(db, ref.appId, ref.productKey)).toEqual([]);
});

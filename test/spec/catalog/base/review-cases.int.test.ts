import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReparseResult } from '../../../../apps/api/src/modules/catalog/index.ts';
import { aliases, enabled, instant, rawRequest, reference, setup, stored } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

// 补充 #15：两侧都要解析，不能只解析左侧，也不能只解析旧键一跳。
it('[AC-B1-05c#33] BR-PROD-01 新旧键交换左右和不同旧键汇合都判为同商品', async () => {
  const { catalog } = setup(db);
  await aliases(db, ['tb:reviewOld', 'tb:reviewNew']);
  const left = { appId: 'review-same', platform: 'taobao', productKey: 'tb:reviewOld' } as const;
  expect(await catalog.isSameProduct({ ...left, productKey: 'tb:reviewNew' }, left)).toBe(true);

  await aliases(db, ['tb:reviewX0', 'tb:reviewX1', 'tb:reviewEnd']);
  await aliases(db, ['tb:reviewY0', 'tb:reviewY1', 'tb:reviewEnd']);
  for (const [a, b] of [
    ['tb:reviewX0', 'tb:reviewX1'],
    ['tb:reviewX0', 'tb:reviewY0'],
  ]) {
    const first = { ...left, productKey: a! };
    const second = { ...left, productKey: b! };
    expect(await catalog.isSameProduct(first, second)).toBe(true);
    expect(await catalog.isSameProduct(second, first)).toBe(true);
  }
});

// 补充 #22：每种失败分类都带一个过期 1ms 的第一级引用。
it.each([
  ['item_ref', 'off_shelf', 30141],
  ['item_ref', 'ref_expired', 30143],
  ['item_ref', 'temporary_failure', 50401],
  ['link', 'off_shelf', 30141],
  ['link', 'ref_expired', 30143],
  ['link', 'temporary_failure', 50401],
] as const)(
  '[AC-B1-05c#34] BR-PROD-05 %s 过期后重解析 %s 返回 %i，不能回退请求原串',
  async (source, kind, code) => {
    const { catalog } = setup(db);
    const old = reference({
      appId: `review-${source}-${kind}`,
      receivedAt: instant(-1_800_001),
      rawItemId: 'STALE-DB-K1',
    });
    await catalog.registerProductRef(old, enabled);
    const request = rawRequest({
      appId: old.appId,
      requestRef: {
        appId: old.appId,
        platform: old.platform,
        productKey: old.productKey,
        rawItemId: 'STALE-REQUEST-K1',
        fetchedAt: instant(-1_800_001),
        source,
      },
      reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind })),
    });
    await expect(catalog.takeRawItemId(request)).rejects.toMatchObject({ code });
    expect(request.reparse).toHaveBeenCalledTimes(1);
    expect(await catalog.readProductRef(old)).toEqual(old);
  },
);

// 补充 #31：异常路径也不能从过期的 item_ref / link 里取原串。
it.each(['item_ref', 'link'] as const)(
  '[AC-B1-05c#35] BR-PROD-05 %s 过期且重解析抛错时仍拒绝返回原串',
  async (source) => {
    const { catalog } = setup(db);
    const old = reference({
      appId: `review-throw-${source}`,
      receivedAt: instant(-1_800_001),
      rawItemId: 'STALE-DB-K1',
    });
    await catalog.registerProductRef(old, enabled);
    const request = rawRequest({
      appId: old.appId,
      requestRef: {
        appId: old.appId,
        platform: old.platform,
        productKey: old.productKey,
        rawItemId: 'STALE-REQUEST-K1',
        fetchedAt: instant(-1_800_001),
        source,
      },
      reparse: vi.fn(async () => {
        throw new Error('reparse unavailable');
      }),
    });
    await expect(catalog.takeRawItemId(request)).rejects.toThrow();
    expect(request.reparse).toHaveBeenCalledTimes(1);
    expect(await catalog.readProductRef(old)).toEqual(old);
  },
);

// 补充 #11：catalog 读取字典能力，运行期开关不能创造平台不支持的搜索能力。
it('[AC-B1-05c#36] BR-PROD-10 字典无搜索能力且解析关闭返回 30131，不登记商品引用', async () => {
  const { catalog } = setup(db);
  const original = await sql<{ search_support: string }>`
    SELECT search_support FROM app.platforms WHERE code = 'taobao'
  `.execute(db);
  expect(original.rows).toHaveLength(1);
  await sql`UPDATE app.platforms SET search_support = 'none' WHERE code = 'taobao'`.execute(db);
  try {
    const capabilities = { parseEnabled: false, searchEnabled: true };
    await expect(catalog.requirePlatform('taobao', capabilities)).rejects.toMatchObject({
      code: 30131,
    });
    const ref = reference({ appId: 'review-no-search' });
    await expect(catalog.registerProductRef(ref, capabilities)).rejects.toMatchObject({
      code: 30131,
    });
    expect(await stored(db, ref.appId, ref.productKey)).toEqual([]);
    expect(
      await catalog.requirePlatform('taobao', { parseEnabled: true, searchEnabled: false }),
    ).toMatchObject({ code: 'taobao', search_support: 'none' });
  } finally {
    await sql`UPDATE app.platforms SET search_support = ${original.rows[0]!.search_support}
      WHERE code = 'taobao'`.execute(db);
  }
});

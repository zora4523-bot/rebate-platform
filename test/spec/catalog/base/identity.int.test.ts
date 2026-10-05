import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { aliases, enabled, reference, setup } from './kit.ts';

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

it('[AC-B1-05c#9] 平台字典从表读取能力、前缀和阶段，不把天猫另列为平台', async () => {
  const { catalog } = setup(db);
  const actual = await catalog.listPlatforms();
  const rows = (
    await sql`SELECT code, key_prefix, key_stability, search_support,
    convert_support, order_sync_support, stage FROM app.platforms ORDER BY code`.execute(db)
  ).rows;
  expect([...actual].sort((a, b) => a.code.localeCompare(b.code))).toEqual(rows);
  expect(actual.map((row) => row.code).sort()).toEqual([
    'douyin',
    'eleme',
    'jd',
    'kuaishou',
    'meituan',
    'pdd',
    'suning',
    'taobao',
    'vip',
  ]);
  expect(actual.find((row) => row.code === 'taobao')).toMatchObject({ key_prefix: 'tb' });
  expect(actual.find((row) => row.code === 'eleme')).toMatchObject({ key_prefix: null });
});

it('[AC-B1-05c#10] 字典能力变更由新读取者看到，不返回硬编码种子', async () => {
  const { catalog } = setup(db);
  await sql`UPDATE app.platforms SET key_stability = 'stable_7d', search_support = 'none' WHERE code = 'pdd'`.execute(
    db,
  );
  try {
    expect((await catalog.listPlatforms()).find((row) => row.code === 'pdd')).toMatchObject({
      key_stability: 'stable_7d',
      search_support: 'none',
    });
  } finally {
    await sql`UPDATE app.platforms SET key_stability = 'unverified', search_support = 'supported' WHERE code = 'pdd'`.execute(
      db,
    );
  }
});

it('[AC-B1-05c#11] BR-PROD-10 未登记编码、数字编码或两种能力均关闭返回 30131', async () => {
  const { catalog } = setup(db);
  for (const code of ['unknown', '1', 'tmall', 'TAOBAO']) {
    await expect(catalog.requirePlatform(code, enabled)).rejects.toMatchObject({ code: 30131 });
  }
  await expect(
    catalog.requirePlatform('taobao', { parseEnabled: false, searchEnabled: false }),
  ).rejects.toMatchObject({ code: 30131 });
});

it('[AC-B1-05c#12] BR-PROD-10 解析或搜索任一开启即支持，与转链能力标记无关', async () => {
  const { catalog } = setup(db);
  for (const appId of ['convert-true', 'convert-false']) {
    await sql`INSERT INTO app.config_items (app_id, key, value, version, updated_by)
      VALUES (${appId}, 'convert.enabled.jd', 'false'::jsonb, 1, 'catalog-test')`.execute(db);
  }
  await sql`UPDATE app.platforms SET convert_support = 'none' WHERE code = 'jd'`.execute(db);
  try {
    for (const capabilities of [
      { parseEnabled: true, searchEnabled: false },
      { parseEnabled: false, searchEnabled: true },
    ]) {
      expect(await catalog.requirePlatform('jd', capabilities)).toMatchObject({
        code: 'jd',
        key_prefix: 'jd',
      });
      const ref = reference({
        appId: `convert-${String(capabilities.parseEnabled)}`,
        platform: 'jd',
        productKey: 'jd:123',
        rawItemId: '123',
      });
      await catalog.registerProductRef(ref, capabilities);
      expect(await catalog.readProductRef(ref)).toEqual(ref);
    }
  } finally {
    await sql`UPDATE app.platforms SET convert_support = 'supported' WHERE code = 'jd'`.execute(db);
  }
});

it('[AC-B1-05c#30] BR-PROD-01 跨应用或平台应在别名解析前拒绝比较', async () => {
  const { catalog, warn } = setup(db);
  await aliases(db, ['tb:isolated0', 'tb:isolated1', 'tb:isolated0']);
  const left = { appId: 'isolation-a', platform: 'taobao', productKey: 'tb:isolated0' } as const;
  expect(await catalog.isSameProduct(left, { ...left, appId: 'isolation-b' })).toBe(false);
  expect(await catalog.isSameProduct(left, { ...left, platform: 'jd' })).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-05c#13] BR-PROD-02 无别名逐字返回，沿链解析到终点，五跳合法', async () => {
  const { catalog, warn } = setup(db);
  await aliases(db, ['tb:chain0', 'tb:chain1', 'tb:chain2', 'tb:chain3', 'tb:chain4', 'tb:chain5']);
  expect(await catalog.resolveProductKey('tb:Unchanged')).toBe('tb:Unchanged');
  expect(await catalog.resolveProductKey('tb:unchanged')).toBe('tb:unchanged');
  expect(await catalog.resolveProductKey('tb:chain0')).toBe('tb:chain5');
  expect(await catalog.resolveProductKey('tb:chain4')).toBe('tb:chain5');
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-05c#14] BR-PROD-02 超过五跳或成环返回原键，并发出告警', async () => {
  const { catalog, warn } = setup(db);
  await aliases(db, [
    'tb:long0',
    'tb:long1',
    'tb:long2',
    'tb:long3',
    'tb:long4',
    'tb:long5',
    'tb:long6',
  ]);
  await aliases(db, ['tb:cycle0', 'tb:cycle1', 'tb:cycle0']);
  expect(await catalog.resolveProductKey('tb:long0')).toBe('tb:long0');
  expect(warn).toHaveBeenCalledWith({ kind: 'alias_limit', key: 'tb:long0' });
  expect(await catalog.resolveProductKey('tb:cycle0')).toBe('tb:cycle0');
  expect(warn).toHaveBeenCalledWith({ kind: 'alias_cycle', key: 'tb:cycle0' });
});

it('[AC-B1-05c#15] BR-PROD-01 同商品必须同应用、同平台、非空键、解析后逐字相等', async () => {
  const { catalog } = setup(db);
  await aliases(db, ['tb:sameOld', 'tb:sameNew']);
  const left = { appId: 'same-a', platform: 'taobao', productKey: 'tb:sameOld' } as const;
  expect(await catalog.isSameProduct(left, { ...left, productKey: 'tb:sameNew' })).toBe(true);
  expect(await catalog.isSameProduct(left, left)).toBe(true);
  for (const right of [
    { ...left, appId: 'same-b' },
    { ...left, platform: 'jd' as const },
    { ...left, productKey: 'tb:samenew' },
    { ...left, productKey: null },
    { ...left, productKey: 'tb:other' },
  ]) {
    expect(await catalog.isSameProduct(left, right)).toBe(false);
    expect(await catalog.isSameProduct(right, left)).toBe(false);
  }
  expect(
    await catalog.isSameProduct({ ...left, productKey: null }, { ...left, productKey: null }),
  ).toBe(false);
});

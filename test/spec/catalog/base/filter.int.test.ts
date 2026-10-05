import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setup } from './kit.ts';

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

it('[AC-B1-05c#26] 类目黑名单按应用和平台过滤，禁用行不影响结果，保留顺序与业务字段', async () => {
  const { catalog } = setup(db);
  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES ('0199a3b4-5c6d-7000-8000-000000000001', 'filter-a', 'taobao', '10', NULL, '测试', 'active', 'test'),
           ('0199a3b4-5c6d-7000-8000-000000000002', 'filter-a', 'taobao', '20', NULL, '测试', 'disabled', 'test'),
           ('0199a3b4-5c6d-7000-8000-000000000003', 'filter-b', 'taobao', '30', NULL, '测试', 'active', 'test')`.execute(
    db,
  );
  const items = [
    { platform: 'taobao', categoryId: '10', title: '被过滤', id: 'a' },
    { platform: 'jd', categoryId: '10', title: '不同平台', id: 'b' },
    { platform: 'taobao', categoryId: '20', title: '已禁用规则', id: 'c' },
    { platform: 'taobao', categoryId: '30', title: '不同应用规则', id: 'd' },
  ] as const;
  expect(await catalog.filterCategories('filter-a', items)).toEqual(items.slice(1));
  expect(await catalog.filterCategories('filter-absent', items)).toEqual(items);
  expect(items).toHaveLength(4);
  expect(await catalog.filterCategories('filter-a', [])).toEqual([]);
});

it('[AC-B1-05c#27] 类目加关键词按字面子串过滤，不把标点解释成正则', async () => {
  const { catalog } = setup(db);
  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES ('0199a3b4-5c6d-7000-8000-000000000004', 'filter-word', 'taobao', '40', 'A+B', '测试', 'active', 'test')`.execute(
    db,
  );
  const items = [
    { platform: 'taobao', categoryId: '40', title: '组合 A+B 套装', position: 1 },
    { platform: 'taobao', categoryId: '40', title: '组合 AAAB 套装', position: 2 },
    { platform: 'taobao', categoryId: '41', title: '组合 A+B 套装', position: 3 },
    { platform: 'pdd', categoryId: '40', title: '组合 A+B 套装', position: 4 },
  ] as const;
  const before = structuredClone(items);
  expect(await catalog.filterCategories('filter-word', items)).toEqual(items.slice(1));
  expect(items).toEqual(before);
});

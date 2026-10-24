// 列表 / 详情（listRightsImports / getRightsImport）：按 App 隔离，created_at 倒序分页，越过末页 items=[]；
// 列表行不带 failures；详情带全部逐行失败（按 row_no）；未知、非 UUID 或别的 App 的 import_id → 20001
// [import_id]；读不写审计。用例全部是顶层 it（资金 / 归属测试路径，规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ADMIN_NAME, fixture, open, type Fixture, type Harness } from './db-kit.ts';
import { NOW, conforms, fieldsError, ms } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const at = (seconds: number) => new Date(new Date(NOW).getTime() + seconds * 1000);
const ids = (page: { items: { import_id: string }[] }) => page.items.map((i) => i.import_id);

/** Five tasks of the fixture's app, created one second apart (oldest first). */
async function five(f: Fixture) {
  const rows: Awaited<ReturnType<Fixture['seed']>>[] = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(await f.seed({ created_at: at(i), finished_at: at(i + 60) }));
  }
  return rows;
}

// ---------------------------------------------------------------- 列表：分页、倒序

it('[AC-B1-09g#16] created_at 倒序；page / page_size 分页；越过末页 items=[]；total 为本 App 的任务数', async () => {
  const f = await fixture(h);
  const rows = await five(f);
  const newest = rows.map((r) => r.id).reverse();
  const pages: Awaited<ReturnType<Fixture['list']>>[] = [];
  for (const page of [1, 2, 3, 4]) pages.push(await f.list({ page, page_size: 2 }));
  expect(pages.map(ids)).toEqual([newest.slice(0, 2), newest.slice(2, 4), newest.slice(4), []]);
  for (const [i, page] of pages.entries()) {
    expect(page).toMatchObject({ page: i + 1, page_size: 2, total: 5 });
    await conforms(page, 'AdminRightsImportPage');
  }
});

it('[AC-B1-09g#16] 同一时刻的任务：顺序稳定，翻页不重不漏', async () => {
  const f = await fixture(h);
  const same = [await f.seed({ created_at: at(5) }), await f.seed({ created_at: at(5) })];
  await f.seed({ created_at: at(9) });
  const first = [await f.list({ page: 2, page_size: 1 }), await f.list({ page: 3, page_size: 1 })];
  const again = [await f.list({ page: 2, page_size: 1 }), await f.list({ page: 3, page_size: 1 })];
  expect(first.flatMap(ids)).toEqual(again.flatMap(ids));
  expect([...first.flatMap(ids)].sort()).toEqual(same.map((r) => r.id).sort());
});

it('[AC-B1-09g#16] 列表行：五项计数、建单人与显示名、时间；不带 failures', async () => {
  const f = await fixture(h);
  const row = await f.seed({
    kind: 'channel',
    union_account_id: f.accountId,
    status: 'done',
    total_rows: 10,
    succeeded_rows: 5,
    failed_rows: 2,
    skipped_rows: 2,
    duplicate_rows: 1,
    created_at: at(1),
    finished_at: at(91),
  });
  await f.seedFailures(row.id, [[3, 'invalid_row']]);
  const page = await f.list();
  expect(page.items).toHaveLength(1);
  const item = page.items[0]!;
  expect(item).toEqual({
    import_id: row.id,
    kind: 'channel',
    platform: 'taobao',
    status: 'done',
    total_rows: 10,
    succeeded_rows: 5,
    failed_rows: 2,
    skipped_rows: 2,
    duplicate_rows: 1,
    created_by: f.adminId,
    created_by_name: ADMIN_NAME,
    created_at: expect.any(String),
    finished_at: expect.any(String),
  });
  expect(ms(item.created_at)).toBe(at(1).getTime());
  expect(ms(item.finished_at)).toBe(at(91).getTime());
});

it('[AC-B1-09g#16] queued / running 的任务 finished_at 为 null；没有显示名的建单人用登录名', async () => {
  const f = await fixture(h);
  const plain = await f.admin({ display_name: null, login_name: 'ri_plain_admin_login' });
  const queued = await f.seed({ status: 'queued', created_by: plain, created_at: at(2) });
  const running = await f.seed({ status: 'running', created_at: at(1) });
  const page = await f.list();
  expect(page.items).toMatchObject([
    { import_id: queued.id, status: 'queued', finished_at: null, created_by: plain },
    { import_id: running.id, status: 'running', finished_at: null, created_by: f.adminId },
  ]);
  expect(page.items[0]?.created_by_name).toBe('ri_plain_admin_login');
  expect(page.items[1]?.created_by_name).toBe(ADMIN_NAME);
});

// ---------------------------------------------------------------- 按 App 隔离

it('[AC-B1-09g#17] 列表只有本 App 的任务；别的 App 的任务详情 → 20001 [import_id]', async () => {
  const mine = await fixture(h);
  const theirs = await fixture(h);
  const own = await mine.seed({ created_at: at(1) });
  const other = await theirs.seed({ created_at: at(2) });
  await theirs.seedFailures(other.id, [[2, 'order_not_found']]);
  const page = await mine.list();
  expect(ids(page)).toEqual([own.id]);
  expect(page.total).toBe(1);
  expect(await mine.detail(other.id)).toEqual(fieldsError('import_id'));
  expect(await theirs.detail(other.id)).toMatchObject({
    code: 0,
    data: { import_id: other.id, failures: [{ row_no: 2, reason: 'order_not_found' }] },
  });
});

// ---------------------------------------------------------------- 详情

it('[AC-B1-09g#18] 详情：列表行的字段加全部逐行失败，按 row_no 排', async () => {
  const f = await fixture(h);
  const row = await f.seed({
    kind: 'punish',
    platform: 'jd',
    time_basis: 'paid',
    from: at(-86_400),
    to: at(0),
    status: 'done',
    total_rows: 4,
    succeeded_rows: 1,
    failed_rows: 3,
    created_at: at(3),
    finished_at: at(30),
  });
  await f.seedFailures(row.id, [
    [5, 'invalid_row'],
    [2, 'received_at_missing'],
    [4, 'platform_mismatch'],
  ]);
  const result = await f.detail(row.id);
  expect(result).toEqual({
    code: 0,
    data: {
      import_id: row.id,
      kind: 'punish',
      platform: 'jd',
      status: 'done',
      total_rows: 4,
      succeeded_rows: 1,
      failed_rows: 3,
      skipped_rows: 0,
      duplicate_rows: 0,
      created_by: f.adminId,
      created_by_name: ADMIN_NAME,
      created_at: expect.any(String),
      finished_at: expect.any(String),
      failures: [
        { row_no: 2, reason: 'received_at_missing' },
        { row_no: 4, reason: 'platform_mismatch' },
        { row_no: 5, reason: 'invalid_row' },
      ],
    },
  });
  await conforms(result.data, 'AdminRightsImportDetail');
});

it.each([
  ['未知的 UUID', () => randomUUID()],
  ['不是 UUID', () => 'not-a-uuid'],
  ['空串', () => ''],
])('[AC-B1-09g#18] 详情 import_id 为%s → 20001 [import_id]', async (_label, id) => {
  const f = await fixture(h);
  await f.seed();
  expect(await f.detail(id())).toEqual(fieldsError('import_id'));
});

it('[AC-B1-09g#18] 读不写审计', async () => {
  const f = await fixture(h);
  const row = await f.seed();
  await f.list();
  await f.detail(row.id);
  expect((await f.state()).audits).toEqual([]);
  expect(await f.detail(row.id)).toMatchObject({ code: 0 });
});

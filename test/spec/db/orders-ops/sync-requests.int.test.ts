// 04 §3.2 order_sync_requests; 编排 B1-09e 技术取舍: filter_digest 与 (app_id, filter_digest)
// WHERE status IN ('queued','running') 部分唯一; CHECK 照 CT-24n order_sync_mode / order_sync_status.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ORDER_SYNC_MODE,
  ORDER_SYNC_STATUS,
  columns,
  connect,
  expectCheckLists,
  insert,
  requireTable,
  sqlState,
  syncRequest,
  unique,
  uniqueIndexesOn,
} from './kit.ts';

const TABLE = 'order_sync_requests';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function add(values: Record<string, unknown>): Promise<string> {
  return sqlState(insert(app, TABLE, await syncRequest(values)));
}

async function setStatus(id: unknown, status: string): Promise<string> {
  return sqlState(
    sql`UPDATE app.order_sync_requests SET status = ${status} WHERE id = ${id}`.execute(app),
  );
}

it('[B1-09e] order_sync_requests 有 04 §3.2 的全部列，另有 app_id 与非空的 filter_digest', async () => {
  await requireTable(app, TABLE);
  const cols = await columns(TABLE);
  expect(cols.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'id',
      'app_id',
      'platform',
      'mode',
      'from',
      'to',
      'status_filter',
      'order_nos',
      'status',
      'requested_by',
      'fetched_count',
      'stored_count',
      'error',
      'created_at',
      'finished_at',
      'filter_digest',
    ]),
  );
  const nullable = Object.fromEntries(cols.map((c) => [c.name, c.nullable]));
  expect(nullable).toMatchObject({
    app_id: false,
    filter_digest: false,
    status: false,
    mode: false,
    status_filter: true,
    order_nos: true,
    error: true,
    finished_at: true,
  });
});

it('[B1-09e] (app_id, filter_digest) 唯一索引是部分索引，谓词只含 queued / running', async () => {
  await requireTable(app, TABLE);
  const found = await uniqueIndexesOn(app, TABLE, ['app_id', 'filter_digest']);
  expect(found.length, 'a unique index on (app_id, filter_digest)').toBeGreaterThan(0);
  for (const index of found) {
    expect(index.predicate, index.name).not.toBeNull();
    expect(index.predicate, index.name).toMatch(/'queued'/);
    expect(index.predicate, index.name).toMatch(/'running'/);
    expect(index.predicate, index.name).not.toMatch(/'done'|'failed'/);
  }
});

it.each<[string, string]>([
  ['queued', 'queued'],
  ['queued', 'running'],
  ['running', 'queued'],
  ['running', 'running'],
])(
  '[B1-09e] 同一 app 同一筛选摘要：已有 %s 时再插入 %s 被唯一约束拒绝（23505）',
  async (first, second) => {
    await requireTable(app, TABLE);
    const digest = unique('digest');
    expect(await add({ filter_digest: digest, status: first })).toBe('no error');
    expect(await add({ filter_digest: digest, status: second })).toBe('23505');
  },
);

it('[B1-09e] done / failed 的请求不占筛选摘要：同摘要可有多条已结束请求，并可再排一条 queued', async () => {
  await requireTable(app, TABLE);
  const digest = unique('digest');
  for (const status of ['done', 'failed', 'done', 'failed', 'queued'] as const) {
    expect(await add({ filter_digest: digest, status }), status).toBe('no error');
  }
  expect(await add({ filter_digest: digest, status: 'running' })).toBe('23505');
});

it.each(['done', 'failed'] as const)(
  '[B1-09e] 排队请求经 running 结束为 %s 后，同一筛选摘要可以再排队',
  async (end) => {
    await requireTable(app, TABLE);
    const digest = unique('digest');
    const first = await syncRequest({ filter_digest: digest, status: 'queued' });
    expect(await sqlState(insert(app, TABLE, first))).toBe('no error');
    expect(await add({ filter_digest: digest })).toBe('23505');
    expect(await setStatus(first['id'], 'running')).toBe('no error');
    expect(await add({ filter_digest: digest })).toBe('23505');
    expect(await setStatus(first['id'], end)).toBe('no error');
    expect(await add({ filter_digest: digest })).toBe('no error');
  },
);

it('[B1-09e] 已结束请求改回 running 时，与正在排队的同摘要请求冲突（23505）', async () => {
  await requireTable(app, TABLE);
  const digest = unique('digest');
  const finished = await syncRequest({ filter_digest: digest, status: 'done' });
  expect(await sqlState(insert(app, TABLE, finished))).toBe('no error');
  expect(await add({ filter_digest: digest, status: 'queued' })).toBe('no error');
  expect(await setStatus(finished['id'], 'running')).toBe('23505');
});

it('[B1-09e] 排队期间唯一按 app 与摘要分开：不同 app 同摘要、同 app 不同摘要都可并存', async () => {
  await requireTable(app, TABLE);
  const digest = unique('digest');
  expect(await add({ filter_digest: digest })).toBe('no error');
  expect(await add({ app_id: 'couli_two', filter_digest: digest })).toBe('no error');
  expect(await add({ filter_digest: unique('digest') })).toBe('no error');
});

it('[B1-09e] status 的 CHECK 照 CT-24n order_sync_status：枚举值都能写，枚举外的值 23514', async () => {
  await requireTable(app, TABLE);
  await expectCheckLists(TABLE, 'status', ORDER_SYNC_STATUS);
  for (const status of ORDER_SYNC_STATUS) {
    expect(await add({ status }), status).toBe('no error');
  }
  for (const status of ['cancelled', 'QUEUED', 'open']) {
    expect(await add({ status }), status).toBe('23514');
  }
});

it('[B1-09e] mode 的 CHECK 照 CT-24n order_sync_mode：枚举外的值 23514', async () => {
  await requireTable(app, TABLE);
  await expectCheckLists(TABLE, 'mode', ORDER_SYNC_MODE);
  expect(await add({ mode: 'window' })).toBe('no error');
  for (const mode of ['range', 'WINDOW', 'order_no']) {
    expect(await add({ mode }), mode).toBe('23514');
  }
});

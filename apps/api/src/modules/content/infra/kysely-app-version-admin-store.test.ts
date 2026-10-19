import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AppVersionAdmin,
  AppVersionConflictError,
  type AdminAppVersionSaveBody,
} from '../application/app-version-admin.ts';
import {
  createKyselyAppVersionAdminStore,
  isUniqueViolation,
} from './kysely-app-version-admin-store.ts';

const APP = 'app_versions_store_unit';
const AT = '2026-10-19T02:00:00.000Z';
const ID = '01920000-0000-7000-8000-000000000002';
const actor = { appId: APP, adminId: 'admin-1', ip: null };
const pre = { appId: APP, platform: 'android', channel: 'official', row: null };
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

const body: AdminAppVersionSaveBody = {
  latest_version: '1.2.0',
  min_supported_version: null,
  recommended_version: null,
  update_title: '',
  update_notes: '',
  store_url: 'https://store.example.test/app',
  default_store: 'store_a',
  store_listings: [
    { store: 'store_b', listed_version: '1.2.0' },
    { store: 'store_a', listed_version: null },
  ],
  confirmed_stores: [],
  expected_row_version: null,
};

const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

// Real SQL compiler and result mapping without a database or socket.
async function fixture(answer: (query: CompiledQuery) => unknown[] | Error, commitError?: Error) {
  const driver = new DummyDriver();
  if (commitError !== undefined) driver.commitTransaction = () => Promise.reject(commitError);
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const rows = answer(query);
    if (rows instanceof Error) throw rows;
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const append = vi.fn(async () => undefined);
  const store = createKyselyAppVersionAdminStore(db, () => ({ append }));
  const admin = new AppVersionAdmin({
    store,
    clock: new FixedClock(AT),
    logger: { warn: vi.fn() },
    newId: () => ID,
  });
  return { admin, queries, append };
}

const insertedRow = {
  ...body,
  platform: 'android',
  channel: 'official',
  row_version: 0,
  updated_at: new Date(AT),
};

it('[AC-F1-02zc] 新建：锁行 FOR UPDATE、ON CONFLICT DO NOTHING、登记按请求顺序写 jsonb、时间取 Clock', async () => {
  const f = await fixture((query) =>
    /^insert into "app"\."app_versions"/i.test(query.sql) ? [insertedRow] : [],
  );
  const saved = await f.admin.save(actor, 'android', 'official', body, pre);
  expect(saved.updated_at).toBe(AT);
  const lock = f.queries.find((query) => /from "app"\."app_versions"/i.test(query.sql))!;
  expect(lock.sql).toMatch(/for update$/i);
  const insert = f.queries.find((query) => /^insert into "app"\."app_versions"/i.test(query.sql))!;
  expect(insert.sql).toMatch(/on conflict \("app_id", "platform", "channel"\) do nothing/i);
  expect(insert.parameters).toContain(JSON.stringify(body.store_listings));
  expect(insert.parameters).toContain(ID);
  expect(insert.parameters.filter((value) => value instanceof Date)).toEqual([
    new Date(AT),
    new Date(AT),
  ]);
  expect(f.append).toHaveBeenCalledTimes(1);
});

it('[AC-F1-02zc] 并发新建：ON CONFLICT 未写入 → 20902，不审计', async () => {
  const f = await fixture(() => []);
  await expect(f.admin.save(actor, 'android', 'official', body, pre)).rejects.toBeInstanceOf(
    AppVersionConflictError,
  );
  expect(f.append).not.toHaveBeenCalled();
});

it('[AC-F1-02zc] 并发新建撞唯一约束（23505）→ 20902，不是 50001', async () => {
  const f = await fixture((query) =>
    /^insert into "app"\."app_versions"/i.test(query.sql) ? uniqueViolation : [],
  );
  await expect(f.admin.save(actor, 'android', 'official', body, pre)).rejects.toBeInstanceOf(
    AppVersionConflictError,
  );
  expect(f.append).not.toHaveBeenCalled();
});

it('[AC-F1-02zc] 提交时报 23505 → 20902', async () => {
  const f = await fixture(
    (query) => (/^insert into "app"\."app_versions"/i.test(query.sql) ? [insertedRow] : []),
    uniqueViolation,
  );
  await expect(f.admin.save(actor, 'android', 'official', body, pre)).rejects.toBeInstanceOf(
    AppVersionConflictError,
  );
});

it('[AC-F1-02zc] 更新：按 row_version 条件整行替换并 +1', async () => {
  const current = { ...insertedRow, row_version: 4 };
  const f = await fixture((query) => {
    if (/^select/i.test(query.sql)) return [current];
    if (/^update "app"\."app_versions"/i.test(query.sql)) return [{ ...current, row_version: 5 }];
    return [];
  });
  const saved = await f.admin.save(
    actor,
    'android',
    'official',
    { ...body, expected_row_version: 4 },
    { ...pre, row: { row_version: 4, min_supported_version: null } },
  );
  expect(saved.row_version).toBe(5);
  const update = f.queries.find((query) => /^update/i.test(query.sql))!;
  expect(update.sql).toMatch(/"row_version" = "row_version" \+ \$\d+/);
  expect(update.sql).toMatch(/and "row_version" = \$\d+ returning /);
  expect(update.parameters.at(-1)).toBe(4);
});

it('[AC-F1-02zc] 唯一约束判定只认 23505', () => {
  expect(isUniqueViolation(uniqueViolation)).toBe(true);
  expect(isUniqueViolation(Object.assign(new Error('x'), { code: '40001' }))).toBe(false);
  expect(isUniqueViolation(null)).toBe(false);
});

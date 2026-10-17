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
import { ConfigItemAdmin } from '../application/config-item-admin.ts';
import { createKyselyConfigItemStore } from './kysely-config-item-store.ts';

const APP_ID = 'config-author-test';
const KEY = 'order.user_query_months';
const AT = '2026-10-17T00:00:00.000Z';
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const actor = {
  appId: APP_ID,
  adminId: ADMIN_ID,
  loginName: 'seed',
  ip: null,
  traceId: 'config-author-trace',
};
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Exercise the real SQL compiler and response mapping without a database or socket.
async function fixture(updatedBy: string, adminId: string | null) {
  const clock = new FixedClock(AT);
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return {
      rows: [
        {
          key: KEY,
          value: 6,
          version: 2,
          updated_by: updatedBy,
          // PostgreSQL returns null for both an absent history row and a null admin id.
          updated_by_admin_id: adminId,
          updated_at: clock.now(),
        },
      ] as R[],
    };
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
  const warn = vi.fn();
  const store = createKyselyConfigItemStore(db, () => ({ append }));
  return {
    store,
    admin: new ConfigItemAdmin(store, clock, { warn }),
    queries,
    append,
    warn,
    clock,
  };
}

it.each(['seed', 'migration', 'system', 'former-admin-name'])(
  '[AC-F1-10e#11] 列表与单项：当前版本无管理员 id 时 %s 标签返回 null，值、版本与时间保留',
  async (label) => {
    const f = await fixture(label, null);
    const expected = {
      key: KEY,
      value: 6,
      version: 2,
      updated_by: null,
      updated_at: AT,
    };
    const page = await f.admin.list(APP_ID, { page_size: 200 });
    expect(page.items.find((item) => item.key === KEY)).toMatchObject(expected);
    expect(await f.admin.get(APP_ID, KEY)).toMatchObject(expected);
    expect(f.queries).toHaveLength(2);
    for (const query of f.queries) {
      expect(query.sql).toContain('from "app"."config_item_versions"');
      for (const column of ['app_id', 'key', 'version']) {
        expect(query.sql).toContain(
          `"app"."config_item_versions"."${column}" = "app"."config_items"."${column}"`,
        );
      }
      expect(query.sql).toContain('as "updated_by_admin_id"');
    }
    expect(f.queries.map((query) => query.parameters)).toEqual([[APP_ID], [APP_ID, KEY]]);
  },
);

it.each(['seed', 'history-snapshot'])(
  '[AC-F1-10e#11] 列表与单项：当前版本有管理员 id 时保留作者快照 %s',
  async (name) => {
    const f = await fixture(name, ADMIN_ID);
    expect(await f.admin.get(APP_ID, KEY)).toMatchObject({ updated_by: name });
    const page = await f.admin.list(APP_ID, { page_size: 200 });
    expect(page.items.find((item) => item.key === KEY)).toMatchObject({ updated_by: name });
    expect(f.queries.every((query) => !query.sql.includes('admin_users'))).toBe(true);
  },
);

it('[AC-F1-10e#11] 系统行同值写入仍无管理员作者，不新增历史、审计或告警', async () => {
  const f = await fixture('seed', null);
  expect(await f.admin.update(actor, KEY, { value: 6, expected_version: 2 })).toMatchObject({
    value: 6,
    version: 2,
    updated_by: null,
    updated_at: AT,
  });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toContain('as "updated_by_admin_id"');
  expect(f.queries[0]?.sql).toContain('for update');
  expect(f.append).not.toHaveBeenCalled();
  expect(f.warn).not.toHaveBeenCalled();
});

it.each([0, 1])(
  '[AC-F1-10e#11] 管理员写入 expected_version=%i 后即返回作者，不等待历史插入',
  async (expectedVersion) => {
    const f = await fixture(actor.loginName, null);
    const row = await f.store.transaction((tx) =>
      tx.change({ actor, key: KEY, value: 6, expectedVersion, reason: null, at: f.clock.now() }),
    );
    expect(row?.updatedBy).toBe(actor.loginName);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]?.query.kind).toBe(
      expectedVersion === 0 ? 'InsertQueryNode' : 'UpdateQueryNode',
    );
  },
);

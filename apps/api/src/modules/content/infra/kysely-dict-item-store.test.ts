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
import { DictConflictError } from '../application/dict-item-admin.ts';
import { createKyselyDictItemStore } from './kysely-dict-item-store.ts';

const AT = new Date('2026-10-19T01:00:00.000Z');
const actor = { appId: 'dict_sql', adminId: 'admin-1', loginName: 'editor', ip: null };
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// The real SQL compiler without a database or socket; `answer` decides each query's result.
async function fixture(answer: (query: CompiledQuery) => unknown[] | Error = () => []) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const result = answer(query);
    if (result instanceof Error) throw result;
    return { rows: result as R[] };
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
  return { store: createKyselyDictItemStore(db, () => ({ append })), queries, append };
}

it('[AC-F1-02t#u14] 写事务锁 dict_version 行（FOR UPDATE），按锁定版本条件更新并追加历史与字典行', async () => {
  const f = await fixture((query) =>
    query.sql.startsWith('update') ? [{ version: 3 }] : [{ value: '2', version: 2 }],
  );
  await f.store.transaction(async (tx) => {
    const row = await tx.lockVersion(actor.appId);
    await tx.publish({ actor, previous: row, value: '3', at: AT });
    await tx.insertItems([
      {
        appId: actor.appId,
        key: 'order_status.SETTLED.label',
        version: 3,
        text: null,
        createdBy: 'admin-1',
        at: AT,
      },
    ]);
  });
  const sqls = f.queries.map((q) => q.sql);
  const lock = sqls.find((s) => s.includes('from "app"."config_items"'))!;
  expect(lock).toMatch(/for update$/);
  const update = f.queries.find((q) => q.sql.startsWith('update'))!;
  expect(update.sql).toContain('"version" = $');
  expect(update.parameters).toContain(2);
  expect(update.sql).toContain('"row_version" = "row_version" + $');
  const history = f.queries.find((q) =>
    q.sql.includes('insert into "app"."config_item_versions"'),
  )!;
  expect(history.parameters).toContain(3);
  expect(history.parameters).toContain('"3"');
  const items = f.queries.find((q) => q.sql.includes('insert into "app"."dict_items"'))!;
  expect(items.parameters).toEqual(
    expect.arrayContaining(['dict_sql', 'order_status', 'SETTLED.label', 3, null, 'admin-1']),
  );
});

it('[AC-F1-02t#u15] 首发插入 dict_version；主键冲突（并发首发或同版本字典行）映射为 20902 冲突', async () => {
  for (const constraint of ['config_items_pkey', 'dict_items_pkey']) {
    const f = await fixture((query) =>
      query.sql.startsWith('insert')
        ? Object.assign(new Error('duplicate key'), { code: '23505', constraint })
        : [],
    );
    await expect(
      f.store.transaction(async (tx) => {
        await tx.publish({ actor, previous: undefined, value: '1', at: AT });
      }),
    ).rejects.toBeInstanceOf(DictConflictError);
    const insert = f.queries.find((q) => q.sql.startsWith('insert'))!;
    expect(insert.sql).toContain('"app"."config_items"');
    expect(insert.sql).not.toContain('on conflict');
  }
  const other = await fixture(() =>
    Object.assign(new Error('other'), { code: '23505', constraint: 'audit_logs_pkey' }),
  );
  await expect(
    other.store.transaction((tx) => tx.lockVersion(actor.appId)),
  ).rejects.not.toBeInstanceOf(DictConflictError);
});

it('[AC-F1-02t#u16] 读：每键取不高于给定版本的最新行；历史按版本降序再按键字节序，键精确过滤', async () => {
  const f = await fixture((query) =>
    query.sql.includes('count(*)')
      ? [{ total: '1' }]
      : query.sql.includes('distinct on')
        ? [{ dict: 'about', code: 'copy_diagnostics', version: 2, text: null }]
        : [
            {
              dict: 'about',
              code: 'copy_diagnostics',
              version: 2,
              text: null,
              created_by: 'admin-1',
              created_at: AT,
            },
          ],
  );
  const effective = await f.store.read((tx) =>
    tx.effective(actor.appId, 2, ['about.copy_diagnostics']),
  );
  expect([...effective]).toEqual([['about.copy_diagnostics', { text: null, version: 2 }]]);
  const read = f.queries.find((q) => q.sql.includes('distinct on'))!;
  expect(read.sql).toContain('"version" <= $');
  expect(read.parameters).toEqual(expect.arrayContaining(['about', 'copy_diagnostics', 2]));
  expect(await f.store.read((tx) => tx.effective(actor.appId, 0))).toEqual(new Map());
  const page = await f.store.history(actor.appId, 'about.copy_diagnostics', 1, 20);
  expect(page).toEqual({
    items: [
      {
        key: 'about.copy_diagnostics',
        version: 2,
        text: null,
        created_by: 'admin-1',
        created_at: AT.toISOString(),
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
  });
  const list = f.queries.find((q) => q.sql.includes('order by "version" desc'))!;
  expect(list.sql).toContain('dict collate "C", code collate "C"');
  expect(list.parameters).toEqual(expect.arrayContaining(['about', 'copy_diagnostics']));
});

it('[AC-F1-02t#u17] 被拒审计不在业务事务里，直接经审计端口追加', async () => {
  const f = await fixture();
  const input = {
    appId: actor.appId,
    actor: 'admin-1',
    action: 'dict_items_denied',
    target: 'dict_items',
    before: null,
    after: { keys: ['wallet.x'], code: 10003 },
    ip: null,
  };
  await f.store.appendAudit(input);
  expect(f.append).toHaveBeenCalledWith(input);
  expect(f.queries).toEqual([]);
});

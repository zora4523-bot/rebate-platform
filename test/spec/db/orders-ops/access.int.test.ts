// 编排 B1-09e 技术取舍: 只给 SELECT / INSERT / 需要的 UPDATE，不给 DELETE；授权写在本迁移。
// db/AGENTS.md 迁移规则 4: 只追加的表（rights_import_failures、order_assignments）不给 UPDATE / DELETE。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  APPEND_ONLY,
  NEW_TABLES,
  PROGRESS_COLUMNS,
  ROLES,
  assignment,
  columns,
  connect,
  importFailure,
  insert,
  requireTable,
  rightsImport,
  sqlState,
  syncRequest,
  type NewTable,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  connect(app);
});
afterAll(async () => {
  for (const db of [app, readonly]) if (db) await destroyDb(db);
  if (database) await database.drop();
});

async function fixture(table: NewTable): Promise<Record<string, unknown>> {
  switch (table) {
    case 'order_sync_requests':
      return syncRequest();
    case 'rights_imports':
      return rightsImport();
    case 'rights_import_failures': {
      const parent = await rightsImport();
      await insert(app, 'rights_imports', parent);
      return importFailure(parent['id']);
    }
    case 'order_assignments':
      return assignment();
  }
}

async function allowed(role: string, table: string, privilege: string): Promise<boolean> {
  const columnGrant = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)
    ? sql<boolean>`has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege})`
    : sql<boolean>`false`;
  const result = await sql<{ allowed: boolean }>`
    SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) OR ${columnGrant}
      AS allowed
  `.execute(app);
  return result.rows[0]?.allowed === true;
}

it.each([...NEW_TABLES])(
  '[B1-09e] %s 的授权矩阵：app 读写（只插入表无 UPDATE），readonly 只读，payout / maint 无权限，无人可 DELETE',
  async (table) => {
    await requireTable(app, table);
    for (const role of ROLES) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const expected =
          (role === 'couli_readonly' && privilege === 'SELECT') ||
          (role === 'couli_app' &&
            (privilege === 'SELECT' ||
              privilege === 'INSERT' ||
              (privilege === 'UPDATE' && !APPEND_ONLY.includes(table))));
        expect(await allowed(role, table, privilege), `${table}/${role}/${privilege}`).toBe(
          expected,
        );
      }
    }
  },
);

it.each(Object.keys(PROGRESS_COLUMNS))(
  '[B1-09e] %s 的状态与计数列可由 app 更新（worker 推进任务）',
  async (table) => {
    await requireTable(app, table);
    const names = (await columns(table)).map((c) => c.name);
    for (const column of PROGRESS_COLUMNS[table] ?? []) {
      expect(names, `${table}.${column}`).toContain(column);
      const result = await sql<{ allowed: boolean }>`
        SELECT has_column_privilege('couli_app', ${`app.${table}`}, ${column}, 'UPDATE') AS allowed
      `.execute(app);
      expect(result.rows, `${table}.${column}`).toEqual([{ allowed: true }]);
    }
  },
);

it.each([...NEW_TABLES])(
  '[B1-09e] 有数据的 %s：app 与 readonly 的 DELETE / TRUNCATE、readonly 的写入都 42501，行不变',
  async (table) => {
    await requireTable(app, table);
    const row = await fixture(table);
    expect(await sqlState(insert(app, table, row))).toBe('no error');
    const read = (db: Kysely<DB>) =>
      sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(db);
    const before = (await read(app)).rows;
    expect((await read(readonly)).rows).toEqual(before);
    expect(await sqlState(insert(readonly, table, await fixture(table)))).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = app_id`.execute(readonly),
      ),
    ).toBe('42501');
    for (const db of [app, readonly]) {
      expect(await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)}`.execute(db))).toBe(
        '42501',
      );
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db))).toBe(
        '42501',
      );
    }
    expect((await read(app)).rows).toEqual(before);
  },
);

it.each([...APPEND_ONLY])(
  '[B1-09e] 只插入的 %s：app 的 UPDATE 也 42501，行不变',
  async (table) => {
    await requireTable(app, table);
    expect(await sqlState(insert(app, table, await fixture(table)))).toBe('no error');
    const read = () => sql`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(app);
    const before = (await read()).rows;
    expect(
      await sqlState(sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = 'rewrite'`.execute(app)),
    ).toBe('42501');
    expect((await read()).rows).toEqual(before);
  },
);

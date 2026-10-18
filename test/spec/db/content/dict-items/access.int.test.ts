import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPE, fixture, insert, ready, type Connection, type Row } from './kit.ts';

let database: TestDatabase;
let app: Connection;
let readonly: Connection;
let payout: Connection;
let maint: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
});
afterAll(async () => {
  for (const db of [app, readonly, payout, maint]) {
    if (db) await destroyDb(db);
  }
  await database?.drop();
});

it('[AC-F1-02q#11] effective table and column privileges allow only app SELECT/INSERT and readonly SELECT', async () => {
  await ready(app);
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]) {
      const allowed =
        (privilege === 'SELECT' && ['couli_app', 'couli_readonly'].includes(role)) ||
        (privilege === 'INSERT' && role === 'couli_app');
      const result = await sql`SELECT
        has_table_privilege(${role}, to_regclass('app.dict_items'), ${privilege}) AS allowed,
        has_table_privilege(${role}, to_regclass('app.dict_items'), ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
        app,
      );
      expect(result.rows, `${role} ${privilege}`).toEqual([{ allowed, grantable: false }]);
    }
    for (const column of Object.keys(SHAPE)) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const allowed =
          (privilege === 'SELECT' && ['couli_app', 'couli_readonly'].includes(role)) ||
          (privilege === 'INSERT' && role === 'couli_app');
        const result = await sql`SELECT
          has_column_privilege(${role}, to_regclass('app.dict_items'), ${column}, ${privilege}) AS allowed,
          has_column_privilege(${role}, to_regclass('app.dict_items'), ${column}, ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
          app,
        );
        expect(result.rows, `${role} ${column} ${privilege}`).toEqual([
          { allowed, grantable: false },
        ]);
      }
    }
  }
}, 30_000);

it('[AC-F1-02q#12] PUBLIC receives no dict_items table or column grants', async () => {
  await ready(app);
  const tables = await sql`SELECT acl.privilege_type FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid = to_regclass('app.dict_items') AND acl.grantee = 0`.execute(app);
  expect(tables.rows).toEqual([]);
  const columns = await sql`SELECT a.attname, acl.privilege_type FROM pg_attribute a
    CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid = to_regclass('app.dict_items') AND acl.grantee = 0`.execute(app);
  expect(columns.rows).toEqual([]);
});

it('[AC-F1-02q#13] app inserts and both app and readonly read the complete version row', async () => {
  const row = await fixture(app);
  expect(await insert(app, row)).toEqual(row);
  for (const db of [app, readonly]) {
    const result =
      await sql<Row>`SELECT * FROM app.dict_items WHERE app_id = ${row.app_id}`.execute(db);
    expect(result.rows).toEqual([row]);
  }
});

it('[AC-F1-02q#14] app and readonly cannot update any column, delete or truncate dictionary versions', async () => {
  const row = await fixture(app);
  await insert(app, row);
  for (const db of [app, readonly]) {
    for (const column of Object.keys(SHAPE)) {
      // Same-value assignment isolates permissions from CHECK/PK/FK failures.
      await expect(
        sql`UPDATE app.dict_items SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE app_id = ${row.app_id}`.execute(db),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      sql`DELETE FROM app.dict_items WHERE app_id = ${row.app_id}`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(sql`TRUNCATE TABLE app.dict_items`.execute(db)).rejects.toMatchObject({
      code: '42501',
    });
  }
  const result = await sql<Row>`SELECT * FROM app.dict_items WHERE app_id = ${row.app_id}`.execute(
    app,
  );
  expect(result.rows).toEqual([row]);
});

it('[AC-F1-02q#15] readonly cannot insert; payout and maint can neither insert nor select', async () => {
  const row = await fixture(app);
  await insert(app, row);
  for (const db of [readonly, payout, maint]) {
    const candidate: Row = { ...row, version: 2 };
    const names = Object.keys(candidate);
    // No RETURNING: denied INSERT cannot be confused with denied SELECT.
    await expect(
      sql`INSERT INTO app.dict_items (${sql.join(names.map((name) => sql.ref(name)))})
      VALUES (${sql.join(names.map((name) => candidate[name]))})`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
  }
  for (const db of [payout, maint]) {
    await expect(
      sql`SELECT * FROM app.dict_items WHERE app_id = ${row.app_id}`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
  }
});

import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPE, appId, fixture, insert, ready, type Connection, type Row } from './kit.ts';

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

it('[AC-F1-02k#16] effective table and column grants match the complete business-role matrix', async () => {
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
        has_table_privilege(${role}, to_regclass('app.agreements'), ${privilege}) AS allowed,
        has_table_privilege(${role}, to_regclass('app.agreements'), ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
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
          has_column_privilege(${role}, to_regclass('app.agreements'), ${column}, ${privilege}) AS allowed,
          has_column_privilege(${role}, to_regclass('app.agreements'), ${column}, ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
          app,
        );
        expect(result.rows, `${role} ${column} ${privilege}`).toEqual([
          { allowed, grantable: false },
        ]);
      }
    }
  }
}, 30_000);

it('[AC-F1-02k#17] PUBLIC has no table or column grants', async () => {
  await ready(app);
  const tables = await sql`SELECT acl.privilege_type
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid = to_regclass('app.agreements') AND acl.grantee = 0`.execute(app);
  expect(tables.rows).toEqual([]);
  const columns = await sql`SELECT a.attname, acl.privilege_type
    FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid = to_regclass('app.agreements') AND acl.grantee = 0`.execute(app);
  expect(columns.rows).toEqual([]);
});

it('[AC-F1-02k#18] app inserts and reads; readonly reads the exact immutable publication', async () => {
  const row = await fixture(app);
  const stored = await insert(app, row);
  expect(stored).toEqual(row);
  for (const db of [app, readonly]) {
    const result = await sql<Row>`SELECT * FROM app.agreements WHERE id = ${row.id}`.execute(db);
    expect(result.rows).toEqual([row]);
  }
});

it('[AC-F1-02k#19] app and readonly cannot update any column, delete or truncate', async () => {
  const row = await fixture(app);
  await insert(app, row);
  for (const db of [app, readonly]) {
    for (const column of Object.keys(SHAPE)) {
      // Same-value assignment isolates permission errors from CHECK/unique/FK violations.
      await expect(
        sql`UPDATE app.agreements SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE id = ${row.id}`.execute(db),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      sql`DELETE FROM app.agreements WHERE id = ${row.id}`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(sql`TRUNCATE TABLE app.agreements`.execute(db)).rejects.toMatchObject({
      code: '42501',
    });
  }
  const result = await sql<Row>`SELECT * FROM app.agreements WHERE id = ${row.id}`.execute(app);
  expect(result.rows).toEqual([row]);
});

it('[AC-F1-02k#20] readonly cannot insert; payout and maint cannot read or insert publications', async () => {
  const row = await fixture(app);
  await insert(app, row);
  for (const db of [readonly, payout, maint]) {
    // No RETURNING: assert INSERT itself is forbidden, independently of SELECT permission.
    const candidate = { ...row, id: randomUUID(), app_id: appId() };
    const names = Object.keys(candidate);
    await expect(
      sql`INSERT INTO app.agreements (${sql.join(names.map((n) => sql.ref(n)))})
      VALUES (${sql.join(names.map((n) => (candidate as Row)[n]))})`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
  }
  for (const db of [payout, maint]) {
    await expect(
      sql`SELECT * FROM app.agreements WHERE id = ${row.id}`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
  }
});

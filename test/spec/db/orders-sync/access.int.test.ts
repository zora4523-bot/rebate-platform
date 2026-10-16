import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  APPEND_ONLY,
  TABLES,
  columns,
  connect,
  fixture,
  insert,
  requireTable,
  sqlState,
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

it('[AC-B1-08c#22] application and readonly grants match the table-specific privilege matrix', async () => {
  for (const table of TABLES) {
    await requireTable(app, table);
    for (const role of ['couli_app', 'couli_readonly']) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const allowed =
          privilege === 'SELECT' ||
          (role === 'couli_app' &&
            (privilege === 'INSERT' || (privilege === 'UPDATE' && !APPEND_ONLY.includes(table))));
        const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(app);
        expect(result.rows, `${table}/${role}/${privilege}`).toEqual([{ allowed }]);
      }
      // A column grant must not bypass a table-level UPDATE/INSERT denial.
      for (const column of await columns(table)) {
        for (const privilege of ['INSERT', 'UPDATE']) {
          const allowed =
            role === 'couli_app' && (privilege === 'INSERT' || !APPEND_ONLY.includes(table));
          const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${column.name}, ${privilege}) AS allowed`.execute(app);
          expect(result.rows, `${table}.${column.name}/${role}/${privilege}`).toEqual([
            { allowed },
          ]);
        }
      }
    }
  }
});

it('[AC-B1-08c#23] populated tables deny DELETE and TRUNCATE to app and all writes to readonly', async () => {
  for (const table of TABLES) {
    await requireTable(app, table);
    const row = await fixture(table);
    expect(await sqlState(insert(app, table, row))).toBe('no error');
    const before = await sql<
      Record<string, unknown>
    >`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(app);
    expect(
      (
        await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(
          readonly,
        )
      ).rows,
    ).toEqual(before.rows);
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
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db))).toBe('42501');
    }
    expect(
      (await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(app))
        .rows,
    ).toEqual(before.rows);
  }
});

it('[AC-B1-08c#24] append-only rows reject UPDATE as well as DELETE and remain unchanged', async () => {
  for (const table of APPEND_ONLY) {
    await requireTable(app, table);
    expect(await sqlState(insert(app, table, await fixture(table)))).toBe('no error');
    const before = await sql<
      Record<string, unknown>
    >`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(app);
    expect(
      await sqlState(sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = 'rewrite'`.execute(app)),
    ).toBe('42501');
    expect(await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)}`.execute(app))).toBe(
      '42501',
    );
    expect(
      (await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(app))
        .rows,
    ).toEqual(before.rows);
  }
});

it('[AC-B1-08c#25] append-only tables also register enabled BEFORE ROW guards for UPDATE and DELETE', async () => {
  for (const table of APPEND_ONLY) {
    await requireTable(app, table);
    const triggers = await sql<{ name: string; type: number }>`
      SELECT tgname::text AS name, tgtype::int AS type FROM pg_trigger
      WHERE tgrelid = to_regclass(${`app.${table}`}) AND NOT tgisinternal
        AND tgenabled IN ('O', 'A')
    `.execute(app);
    for (const event of [8, 16]) {
      expect(
        triggers.rows.some(
          (trigger) =>
            trigger.name.length > 0 && (trigger.type & 3) === 3 && (trigger.type & event) === event,
        ),
        `${table}/${event}`,
      ).toBe(true);
    }
    for (const trigger of triggers.rows) {
      expect(trigger.type & (4 | 32 | 64), trigger.name).toBe(0);
    }
  }
});

// TODO(规划/11 §4.3): Execute append-only guards with UPDATE/DELETE privileges — blocked on
// the trusted harness exposing a permitted probe role; 42501 above proves ACLs, not trigger bodies.

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AT, article, articlesReady, insert, rejects, type Connection, type Row } from './kit.ts';

let database: TestDatabase;
let app: Connection;
let readonly: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  for (const db of [app, readonly]) {
    if (db) await destroyDb(db);
  }
  await database?.drop();
});

it('[AC-F1-02q#16] validated articles_status_check accepts exactly draft, published and offline', async () => {
  await articlesReady(app);
  const row = article();
  for (const status of [
    'Published',
    'published ',
    'archived',
    '',
    'DRAFT',
    'OFFLINE',
    'published\n',
  ]) {
    await rejects(insert(app, { ...row, status }, 'articles'), 'articles_status_check');
  }
  for (const [index, status] of ['draft', 'published', 'offline'].entries()) {
    // No extra published_at rule belongs in this CHECK; scheduled/unpublished filtering
    // remains the read service's responsibility (F1-02f).
    expect(await insert(app, { ...row, version: index + 1, status }, 'articles')).toMatchObject({
      status,
    });
  }
});

it('[AC-F1-02q#17] article UPDATE has no table grant and permits exactly the five mutable columns', async () => {
  // Direct privilege assertion gives a meaningful red before the migration, independently
  // of the new status CHECK.
  const table = await sql`SELECT
    has_table_privilege('couli_app', 'app.articles', 'UPDATE') AS update,
    has_table_privilege('couli_app', 'app.articles', 'SELECT') AS select,
    has_table_privilege('couli_app', 'app.articles', 'INSERT') AS insert,
    has_table_privilege('couli_app', 'app.articles', 'DELETE') AS delete`.execute(app);
  expect(table.rows).toEqual([{ update: false, select: true, insert: true, delete: false }]);
  const mutable = ['status', 'published_at', 'notice_end_at', 'row_version', 'updated_at'];
  const grants = await sql<{
    name: string;
    allowed: boolean;
    grantable: boolean;
  }>`SELECT attname AS name,
    has_column_privilege('couli_app', attrelid, attnum, 'UPDATE') AS allowed,
    has_column_privilege('couli_app', attrelid, attnum, 'UPDATE WITH GRANT OPTION') AS grantable
    FROM pg_attribute WHERE attrelid = to_regclass('app.articles')
      AND attnum > 0 AND NOT attisdropped ORDER BY attname`.execute(app);
  expect(grants.rows.map((c) => c.name)).toEqual(Object.keys(article()).sort());
  for (const column of grants.rows) {
    expect(column, column.name).toEqual({
      name: column.name,
      allowed: mutable.includes(column.name),
      grantable: false,
    });
  }
});

it('[AC-F1-02q#18] app can change each allowed article column and the values persist', async () => {
  await articlesReady(app);
  const row = article();
  await insert(app, row, 'articles');
  const changes: Row = {
    status: 'published',
    published_at: AT,
    notice_end_at: new Date('2026-10-19T08:00:00.000Z'),
    row_version: 1,
    updated_at: new Date('2026-10-18T09:00:00.000Z'),
  };
  for (const [column, value] of Object.entries(changes)) {
    const result = await sql<Row>`UPDATE app.articles SET ${sql.ref(column)} = ${value}
      WHERE id = ${row.id} AND version = ${row.version} RETURNING *`.execute(app);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ [column]: value });
  }
  const result = await sql<Row>`SELECT * FROM app.articles WHERE id = ${row.id}`.execute(app);
  expect(result.rows).toEqual([{ ...row, ...changes }]);
});

it('[AC-F1-02q#19] app cannot update article content, identity or creation time and cannot delete', async () => {
  const row = article();
  await insert(app, row, 'articles');
  for (const column of [
    'title',
    'body',
    'version',
    'category',
    'notice_closable',
    'notice_content_version',
    'app_id',
    'id',
    'created_at',
  ]) {
    await expect(
      sql`UPDATE app.articles SET ${sql.ref(column)} = ${sql.ref(column)}
      WHERE id = ${row.id} AND version = ${row.version}`.execute(app),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    sql`DELETE FROM app.articles WHERE id = ${row.id}`.execute(app),
  ).rejects.toMatchObject({ code: '42501' });
  const result = await sql<Row>`SELECT * FROM app.articles WHERE id = ${row.id}`.execute(app);
  expect(result.rows).toEqual([row]);
});

it('[AC-F1-02q#20] article CHECK also rejects invalid status UPDATE without changing the stored row', async () => {
  await articlesReady(app);
  const row = article();
  await insert(app, row, 'articles');
  for (const status of ['Published', 'published ', 'archived', '']) {
    await rejects(
      sql`UPDATE app.articles SET status = ${status} WHERE id = ${row.id}`.execute(app),
      'articles_status_check',
    );
  }
  const result = await sql<Row>`SELECT * FROM app.articles WHERE id = ${row.id}`.execute(app);
  expect(result.rows).toEqual([row]);
});

it('[AC-F1-02q#21] readonly retains SELECT and cannot insert, update any column, delete or truncate articles', async () => {
  await articlesReady(app);
  const row = article();
  await insert(app, row, 'articles');
  const result = await sql<Row>`SELECT * FROM app.articles WHERE id = ${row.id}`.execute(readonly);
  expect(result.rows).toEqual([row]);
  await expect(insert(readonly, { ...row, version: 2 }, 'articles')).rejects.toMatchObject({
    code: '42501',
  });
  for (const column of Object.keys(row)) {
    await expect(
      sql`UPDATE app.articles SET ${sql.ref(column)} = ${sql.ref(column)}
      WHERE id = ${row.id}`.execute(readonly),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    sql`DELETE FROM app.articles WHERE id = ${row.id}`.execute(readonly),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(sql`TRUNCATE TABLE app.articles`.execute(readonly)).rejects.toMatchObject({
    code: '42501',
  });
});

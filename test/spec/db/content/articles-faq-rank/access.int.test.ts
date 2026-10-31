// F1-02zzo §9.2 item 3 and §9.3 items 5–6: grants stay as they were (faq_rank is not in the
// couli_app column-level UPDATE list; changing the order means saving a new draft version).
// The integration globalSetup alone reads the admin database URL and applies migrations.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  MUTABLE,
  article,
  insert,
  ready,
  stored,
  type Connection,
  type Row,
} from './faq-rank-kit.ts';

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

async function faqRankPrivileges(role: string) {
  return (
    await sql<Row>`SELECT
        has_column_privilege(${role}, 'app.articles', 'faq_rank', 'SELECT') AS select,
        has_column_privilege(${role}, 'app.articles', 'faq_rank', 'INSERT') AS insert,
        has_column_privilege(${role}, 'app.articles', 'faq_rank', 'UPDATE') AS update,
        has_column_privilege(${role}, 'app.articles', 'faq_rank', 'REFERENCES') AS references,
        has_column_privilege(${role}, 'app.articles', 'faq_rank',
          'SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION')
          AS grantable`.execute(app)
  ).rows;
}

it('[AC-F1-02zzo#11] couli_app may SELECT and INSERT faq_rank but not UPDATE it, and cannot grant it on', async () => {
  await ready(app);
  expect(await faqRankPrivileges('couli_app')).toEqual([
    { select: true, insert: true, update: false, references: false, grantable: false },
  ]);
});

it('[AC-F1-02zzo#12] couli_readonly may only SELECT faq_rank; payout and maint get no UPDATE on it', async () => {
  await ready(app);
  expect(await faqRankPrivileges('couli_readonly')).toEqual([
    { select: true, insert: false, update: false, references: false, grantable: false },
  ]);
  for (const role of ['couli_payout', 'couli_maint']) {
    const rows = await faqRankPrivileges(role);
    expect(rows, role).toHaveLength(1);
    expect(rows[0], role).toMatchObject({ update: false, grantable: false });
  }
});

it('[AC-F1-02zzo#13] faq_rank carries no column-level grant and the app UPDATE list is still the original five', async () => {
  await ready(app);
  const acl = await sql`SELECT attacl IS NULL AS "noColumnAcl" FROM pg_attribute
    WHERE attrelid = to_regclass('app.articles') AND attname = 'faq_rank'
      AND NOT attisdropped`.execute(app);
  expect(acl.rows).toEqual([{ noColumnAcl: true }]);
  const table = await sql`SELECT
      has_table_privilege('couli_app', 'app.articles', 'UPDATE') AS app,
      has_table_privilege('couli_readonly', 'app.articles', 'UPDATE') AS readonly`.execute(app);
  expect(table.rows).toEqual([{ app: false, readonly: false }]);
  for (const role of ['couli_app', 'couli_readonly']) {
    const updatable = await sql<{ name: string }>`SELECT attname::text AS name FROM pg_attribute
      WHERE attrelid = to_regclass('app.articles') AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege(${role}, attrelid, attnum, 'UPDATE')
      ORDER BY attname`.execute(app);
    expect(
      updatable.rows.map((row) => row.name),
      role,
    ).toEqual(role === 'couli_app' ? MUTABLE : []);
  }
});

it('[AC-F1-02zzo#14] couli_app UPDATE of faq_rank fails with 42501 and leaves the row unchanged', async () => {
  await ready(app);
  for (const initial of [null, 7]) {
    const row = article({ faq_rank: initial });
    expect(await insert(app, row)).toEqual(row);
    for (const replacement of [null, 7, 8]) {
      await expect(
        sql`UPDATE app.articles SET faq_rank = ${replacement}
          WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1`.execute(app),
        `${initial} -> ${replacement}`,
      ).rejects.toMatchObject({ code: '42501' });
      expect(await stored(app, row)).toEqual([row]);
    }
    await expect(
      sql`UPDATE app.articles SET status = 'published', faq_rank = 9
        WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1`.execute(app),
      'combined with a granted column',
    ).rejects.toMatchObject({ code: '42501' });
    expect(await stored(app, row)).toEqual([row]);
  }
});

it('[AC-F1-02zzo#15] each originally mutable column stays writable and leaves faq_rank untouched', async () => {
  await ready(app);
  const row = article({ faq_rank: 42 });
  await insert(app, row);
  const changes: Row = {
    status: 'published',
    published_at: AT,
    notice_end_at: new Date('2026-10-23T08:00:00.000Z'),
    row_version: 1,
    updated_at: new Date('2026-10-22T09:00:00.000Z'),
  };
  const expected: Row = { ...row };
  for (const [column, value] of Object.entries(changes)) {
    const result = await sql<Row>`UPDATE app.articles SET ${sql.ref(column)} = ${value}
      WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1 RETURNING *`.execute(app);
    expected[column] = value;
    expect(result.rows, column).toEqual([expected]);
    expect(await stored(app, row), column).toEqual([expected]);
  }
});

it('[AC-F1-02zzo#16] couli_readonly reads faq_rank but cannot insert it or update it', async () => {
  await ready(app);
  const row = article({ faq_rank: 3 });
  await insert(app, row);
  expect(await stored(readonly, row)).toEqual([row]);
  const selected = await sql`SELECT faq_rank FROM app.articles
    WHERE app_id = ${row.app_id} AND id = ${row.id}`.execute(readonly);
  expect(selected.rows).toEqual([{ faq_rank: 3 }]);
  await expect(insert(readonly, { ...row, version: 2, faq_rank: 4 })).rejects.toMatchObject({
    code: '42501',
  });
  for (const value of [null, 4]) {
    await expect(
      sql`UPDATE app.articles SET faq_rank = ${value}
        WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1`.execute(readonly),
    ).rejects.toMatchObject({ code: '42501' });
  }
  expect(await stored(app, row)).toEqual([row]);
});

it('[AC-F1-02zzo#17] a new version row of the same article can carry a different faq_rank; older rows keep theirs', async () => {
  await ready(app);
  const v1 = article({ faq_rank: 5 });
  expect(await insert(app, v1)).toEqual(v1);
  const v2 = { ...v1, version: 2, faq_rank: 999, created_at: new Date('2026-10-22T10:00:00.000Z') };
  expect(await insert(app, v2)).toEqual(v2);
  const v3 = { ...v1, version: 3, faq_rank: null, help_section: 'invite' };
  expect(await insert(app, v3)).toEqual(v3);
  const v4 = { ...v1, version: 4, faq_rank: 1 };
  expect(await insert(app, v4)).toEqual(v4);
  expect(await stored(app, v1)).toEqual([v1, v2, v3, v4]);
  expect(await stored(readonly, v1)).toEqual([v1, v2, v3, v4]);
});

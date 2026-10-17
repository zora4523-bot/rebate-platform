import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  SHAPES,
  TABLES,
  UPDATABLE,
  insert,
  ready,
  seeded,
  update,
  type Connection,
} from './kit.ts';

let database: TestDatabase;
let app: Connection;
let readonly: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  await database?.drop();
});

it('[AC-F1-09a#18] effective table and column privileges match the complete business-role matrix', async () => {
  await ready(app);
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const table of TABLES) {
      const relation = `app.${table}`;
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
          privilege === 'SELECT'
            ? role === 'couli_app' || role === 'couli_readonly'
            : privilege === 'INSERT' && role === 'couli_app';
        const result = await sql<{ allowed: boolean; grantable: boolean }>`SELECT
          has_table_privilege(${role}, to_regclass(${relation}), ${privilege}) AS allowed,
          has_table_privilege(${role}, to_regclass(${relation}), ${`${privilege} WITH GRANT OPTION`}) AS grantable
        `.execute(app);
        expect(result.rows, `${role} ${relation} ${privilege}`).toEqual([
          { allowed, grantable: false },
        ]);
      }
      for (const column of Object.keys(SHAPES[table])) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            privilege === 'SELECT'
              ? role === 'couli_app' || role === 'couli_readonly'
              : role === 'couli_app' &&
                (privilege === 'INSERT' ||
                  (privilege === 'UPDATE' && UPDATABLE[table].includes(column)));
          const result = await sql<{ allowed: boolean; grantable: boolean }>`SELECT
            has_column_privilege(${role}, to_regclass(${relation}), ${column}, ${privilege}) AS allowed,
            has_column_privilege(${role}, to_regclass(${relation}), ${column}, ${`${privilege} WITH GRANT OPTION`}) AS grantable
          `.execute(app);
          expect(result.rows, `${role} ${relation}.${column} ${privilege}`).toEqual([
            { allowed, grantable: false },
          ]);
        }
      }
    }
  }
}, 30_000);

it('[AC-F1-09a#19] PUBLIC receives neither table nor column privileges', async () => {
  await ready(app);
  for (const table of TABLES) {
    const tableAcl = await sql`SELECT acl.privilege_type
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
      WHERE c.oid = to_regclass(${`app.${table}`}) AND acl.grantee = 0`.execute(app);
    expect(tableAcl.rows).toEqual([]);
    const columnAcl = await sql`SELECT a.attname, acl.privilege_type
      FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE a.attrelid = to_regclass(${`app.${table}`}) AND acl.grantee = 0`.execute(app);
    expect(columnAcl.rows).toEqual([]);
  }
});

it('[AC-F1-09a#20] content can update only lifecycle fields, pointers, revision and preview usage', async () => {
  const { version, page, token, admin } = await seeded(app);
  await insert(app, 'pages', page);
  await insert(app, 'page_preview_tokens', token);
  const versionKey = { app_id: version.app_id, page_key: version.page_key, version: 1 };
  const published = await update(app, 'page_versions', versionKey, {
    status: 'published',
    publish_at: AT,
    publisher: admin.id,
    render_count: 9007199254740993n,
    error_count: 1n,
  });
  expect(published).toMatchObject({
    status: 'published',
    publish_at: AT,
    publisher: admin.id,
    render_count: 9007199254740993n,
    error_count: 1n,
    sections: [],
    created_at: AT,
    created_by_admin_id: admin.id,
  });
  expect(await update(app, 'page_versions', versionKey, { status: 'rolled_back' })).toMatchObject({
    status: 'rolled_back',
    publish_at: AT,
    publisher: admin.id,
  });
  const pageKey = { app_id: page.app_id, page_key: page.page_key };
  const change = {
    current_version: 1,
    gray_version: 2,
    gray_percent: 99,
    revision: 1,
    updated_by_admin_id: admin.id,
    updated_at: AT,
  };
  expect(await update(app, 'pages', pageKey, change)).toMatchObject(change);
  expect(
    await update(app, 'pages', pageKey, {
      current_version: 2,
      gray_version: null,
      gray_percent: 0,
      revision: 2,
    }),
  ).toMatchObject({ current_version: 2, gray_version: null, gray_percent: 0, revision: 2 });
  expect(
    await update(app, 'page_preview_tokens', { token_hash: token.token_hash }, { used_count: 1 }),
  ).toMatchObject({ ...token, used_count: 1 });
});

it('[AC-F1-09a#21] immutable version content, identity, audit fields and token expiry reject UPDATE', async () => {
  const { version, page, token } = await seeded(app);
  const stored = {
    page_versions: (
      await sql<Record<string, unknown>>`SELECT * FROM app.page_versions
      WHERE app_id = ${version.app_id} AND page_key = 'home' AND version = 1`.execute(app)
    ).rows[0]!,
    pages: await insert(app, 'pages', page),
    page_preview_tokens: await insert(app, 'page_preview_tokens', token),
  };
  for (const table of TABLES) {
    for (const column of Object.keys(SHAPES[table]).filter((c) => !UPDATABLE[table].includes(c))) {
      // A no-op assignment on one real row isolates privilege checking from CHECK/FK errors.
      await expect(
        sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE app_id = ${version.app_id}`.execute(app),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const read = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${version.app_id}`.execute(readonly);
    expect(read.rows).toContainEqual(stored[table]);
  }
});

import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  EMPTY_SLOT,
  SLOT_COLUMNS,
  SLOT_SHAPE,
  columns,
  insert,
  ready,
  rejects,
  seeded,
  update,
  type Connection,
  type Row,
} from './kit.ts';

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

it('[AC-F1-09n#1] four nullable columns have exact types and no defaults', async () => {
  await ready(app);
  expect(await columns(app)).toEqual(
    Object.entries(SLOT_SHAPE)
      .map(([name, type]) => ({ name, type, nullable: 'YES', defaultValue: null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

it('[AC-F1-09n#2] legacy inserts omit the slot; explicit empty slots also remain empty', async () => {
  const { page } = await seeded(app);
  expect(await insert(app, 'pages', page)).toMatchObject(EMPTY_SLOT);
  expect(
    await insert(app, 'pages', { ...page, page_key: 'custom:empty', ...EMPTY_SLOT }),
  ).toMatchObject(EMPTY_SLOT);
});

it.each([1, 99, 100])('[AC-F1-09n#3] complete slot accepts gray percent %i', async (percent) => {
  const { page, slot } = await seeded(app);
  const scheduled = { ...slot, scheduled_gray_percent: percent };
  expect(await insert(app, 'pages', { ...page, ...scheduled })).toMatchObject({
    ...scheduled,
    current_version: null,
    gray_version: null,
    gray_percent: 0,
  });
});

// All 14 partial combinations: this includes each single NULL, each lone value,
// and every pair. SQL CHECK must reject UNKNOWN loopholes as well as FALSE.
it.each(Array.from({ length: 14 }, (_, i) => i + 1))(
  '[AC-F1-09n#4] partial slot mask %i fails the named CHECK on INSERT and UPDATE',
  async (mask) => {
    const { page, slot } = await seeded(app);
    const partial: Row = { ...slot };
    SLOT_COLUMNS.forEach((column, index) => {
      if ((mask & (1 << index)) !== 0) partial[column] = null;
    });
    await rejects(insert(app, 'pages', { ...page, ...partial }), 'pages_scheduled_check');
    await insert(app, 'pages', { ...page, ...slot });
    await rejects(update(app, page, partial), 'pages_scheduled_check');
    const saved = await sql<Row>`SELECT * FROM app.pages
      WHERE app_id = ${page.app_id} AND page_key = ${page.page_key}`.execute(app);
    expect(saved.rows).toMatchObject([slot]);
  },
);

it.each([0, 101, -1])('[AC-F1-09n#5] gray percent %i fails the named CHECK', async (percent) => {
  const { page, slot } = await seeded(app);
  await rejects(
    insert(app, 'pages', { ...page, ...slot, scheduled_gray_percent: percent }),
    'pages_scheduled_check',
  );
  await insert(app, 'pages', { ...page, ...slot });
  await rejects(update(app, page, { scheduled_gray_percent: percent }), 'pages_scheduled_check');
});

it('[AC-F1-09n#6] scheduled CHECK is validated and covers all four columns', async () => {
  await ready(app);
  const result = await sql`SELECT c.convalidated AS validated, c.contype::text AS type,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) AS k(num)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY a.attname) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.pages') AND c.conname = 'pages_scheduled_check'`.execute(app);
  expect(result.rows).toEqual([{ validated: true, type: 'c', columns: [...SLOT_COLUMNS].sort() }]);
});

it('[AC-F1-09n#7] named foreign keys preserve app/page identity and forbid cascading actions', async () => {
  await ready(app);
  const result = await sql`SELECT c.conname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS columns,
      ns.nspname AS "targetSchema", target.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.ord) AS "targetColumns",
      c.confdeltype::text AS "onDelete", c.confupdtype::text AS "onUpdate",
      c.confmatchtype::text AS match, c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class target ON target.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = target.relnamespace
    WHERE c.conrelid = to_regclass('app.pages') AND c.contype = 'f'
      AND c.conname IN ('pages_scheduled_version_fkey', 'pages_scheduled_by_admin_id_fkey')
    ORDER BY c.conname`.execute(app);
  expect(result.rows).toEqual([
    {
      name: 'pages_scheduled_by_admin_id_fkey',
      columns: ['scheduled_by_admin_id'],
      targetSchema: 'app',
      target: 'admin_users',
      targetColumns: ['id'],
      onDelete: 'a',
      onUpdate: 'a',
      match: 's',
      validated: true,
    },
    {
      name: 'pages_scheduled_version_fkey',
      columns: ['app_id', 'page_key', 'scheduled_version'],
      targetSchema: 'app',
      target: 'page_versions',
      targetColumns: ['app_id', 'page_key', 'version'],
      onDelete: 'a',
      onUpdate: 'a',
      match: 's',
      validated: true,
    },
  ]);
});

it.each(['missing', 'other-app', 'other-page'] as const)(
  '[AC-F1-09n#8] scheduled version cannot borrow a %s target on INSERT or UPDATE',
  async (scenario) => {
    const { page, version, slot } = await seeded(app);
    if (scenario !== 'missing') {
      await insert(app, 'page_versions', {
        ...version,
        version: 9,
        ...(scenario === 'other-app'
          ? { app_id: `${page.app_id}_other` }
          : { page_key: 'custom:other' }),
      });
    }
    const invalid = { ...slot, scheduled_version: 9 };
    await rejects(insert(app, 'pages', { ...page, ...invalid }), 'pages_scheduled_version_fkey', '23503');
    await insert(app, 'pages', { ...page, ...slot });
    await rejects(update(app, page, invalid), 'pages_scheduled_version_fkey', '23503');
  },
);

it('[AC-F1-09n#9] nonexistent scheduling admin fails the named FK on INSERT and UPDATE', async () => {
  const { page, slot } = await seeded(app);
  const invalid = { ...slot, scheduled_by_admin_id: randomUUID() };
  await rejects(insert(app, 'pages', { ...page, ...invalid }), 'pages_scheduled_by_admin_id_fkey', '23503');
  await insert(app, 'pages', { ...page, ...slot });
  await rejects(update(app, page, invalid), 'pages_scheduled_by_admin_id_fkey', '23503');
});

it('[AC-F1-09n#10] business-role deletes of referenced versions/admins are refused and leave the slot intact', async () => {
  const { page, slot } = await seeded(app);
  await insert(app, 'pages', { ...page, ...slot });
  // Business roles have no DELETE grant; do not grant privileges or use an owner connection.
  // #7 independently checks the actual FK delete action, so CASCADE/SET NULL cannot pass.
  await expect(sql`DELETE FROM app.page_versions
    WHERE app_id = ${page.app_id} AND page_key = ${page.page_key}
      AND version = ${slot.scheduled_version}`.execute(app)).rejects.toMatchObject({ code: '42501' });
  await expect(sql`DELETE FROM app.admin_users
    WHERE id = ${slot.scheduled_by_admin_id}`.execute(app)).rejects.toMatchObject({ code: '42501' });
  const saved = await sql<Row>`SELECT * FROM app.pages
    WHERE app_id = ${page.app_id} AND page_key = ${page.page_key}`.execute(app);
  expect(saved.rows).toMatchObject([slot]);
  const version = await sql`SELECT version FROM app.page_versions
    WHERE app_id = ${page.app_id} AND page_key = ${page.page_key}
      AND version = ${slot.scheduled_version}`.execute(app);
  expect(version.rows).toEqual([{ version: slot.scheduled_version }]);
  const admin = await sql`SELECT id FROM app.admin_users
    WHERE id = ${slot.scheduled_by_admin_id}`.execute(app);
  expect(admin.rows).toEqual([{ id: slot.scheduled_by_admin_id }]);
});

it.each([1, 2])('[AC-F1-09n#11] slot may equal existing current/gray pointer %i', async (version) => {
  const { page, slot } = await seeded(app);
  const row = {
    ...page,
    ...slot,
    current_version: 1,
    gray_version: 2,
    gray_percent: 10,
    scheduled_version: version,
  };
  expect(await insert(app, 'pages', row)).toMatchObject(row);
});

it.each([
  { current_version: 1, gray_version: 1, gray_percent: 10 },
  { current_version: null, gray_version: 2, gray_percent: 10 },
  { current_version: 1, gray_version: 2, gray_percent: 0 },
  { current_version: 1, gray_version: 2, gray_percent: 100 },
  { current_version: 1, gray_version: null, gray_percent: 10 },
])('[AC-F1-09n#12] scheduled slot does not relax pages_gray_check: %j', async (pointers) => {
  const { page, slot } = await seeded(app);
  await rejects(insert(app, 'pages', { ...page, ...slot, ...pointers }), 'pages_gray_check');
});

it('[AC-F1-09n#13] app can set, replace, update each column and clear the slot without changing live pointers', async () => {
  const { page, slot } = await seeded(app);
  const live = { current_version: 1, gray_version: 2, gray_percent: 10, revision: 7 };
  await insert(app, 'pages', { ...page, ...live });
  expect(await update(app, page, slot)).toMatchObject({ ...slot, ...live });
  const replacement = { ...slot, scheduled_version: 2, scheduled_gray_percent: 100 };
  expect(await update(app, page, replacement)).toMatchObject({ ...replacement, ...live });
  for (const column of SLOT_COLUMNS) {
    expect(await update(app, page, { [column]: slot[column as keyof typeof slot] })).toMatchObject(live);
  }
  expect(await update(app, page, EMPTY_SLOT)).toMatchObject({ ...EMPTY_SLOT, ...live });
  // Scheduling does not publish a draft early or rewrite its timestamp/publisher.
  const versions = await sql`SELECT status, publish_at, publisher FROM app.page_versions
    WHERE app_id = ${page.app_id} ORDER BY version`.execute(app);
  expect(versions.rows).toEqual(
    [1, 2, 3].map(() => ({ status: 'draft', publish_at: null, publisher: null })),
  );
});

it('[AC-F1-09n#14] grants remain column-level with no extra business-role or PUBLIC privileges', async () => {
  await ready(app);
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      const allowed = privilege === 'SELECT'
        ? role === 'couli_app' || role === 'couli_readonly'
        : privilege === 'INSERT' && role === 'couli_app';
      const result = await sql`SELECT
        has_table_privilege(${role}, 'app.pages', ${privilege}) AS allowed,
        has_table_privilege(${role}, 'app.pages', ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(app);
      expect(result.rows, `${role} ${privilege}`).toEqual([{ allowed, grantable: false }]);
    }
    for (const column of SLOT_COLUMNS) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const allowed = privilege === 'SELECT'
          ? role === 'couli_app' || role === 'couli_readonly'
          : role === 'couli_app' && (privilege === 'INSERT' || privilege === 'UPDATE');
        const result = await sql`SELECT
          has_column_privilege(${role}, 'app.pages', ${column}, ${privilege}) AS allowed,
          has_column_privilege(${role}, 'app.pages', ${column}, ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(app);
        expect(result.rows, `${role} ${column} ${privilege}`).toEqual([{ allowed, grantable: false }]);
      }
    }
  }
  const tableAcl = await sql`SELECT acl.privilege_type
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid = to_regclass('app.pages') AND acl.grantee = 0`.execute(app);
  expect(tableAcl.rows).toEqual([]);
  const columnAcl = await sql`SELECT a.attname, acl.privilege_type
    FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid = to_regclass('app.pages') AND acl.grantee = 0`.execute(app);
  expect(columnAcl.rows).toEqual([]);
}, 30_000);

it('[AC-F1-09n#15] readonly reads the slot but cannot update; payout and maint cannot read', async () => {
  const { page, slot } = await seeded(app);
  await insert(app, 'pages', { ...page, ...slot });
  const read = await sql<Row>`SELECT * FROM app.pages
    WHERE app_id = ${page.app_id} AND page_key = ${page.page_key}`.execute(readonly);
  expect(read.rows).toMatchObject([slot]);
  for (const column of SLOT_COLUMNS) {
    await expect(update(readonly, page, { [column]: slot[column as keyof typeof slot] }))
      .rejects.toMatchObject({ code: '42501' });
  }
  for (const db of [payout, maint]) {
    await expect(sql`SELECT scheduled_version FROM app.pages
      WHERE app_id = ${page.app_id}`.execute(db)).rejects.toMatchObject({ code: '42501' });
  }
  await expect(update(app, page, { app_id: page.app_id })).rejects.toMatchObject({ code: '42501' });
});

it('[AC-F1-09n#16] pages retains only its primary-key index', async () => {
  await ready(app);
  const indexes = await sql`SELECT
      i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready
    FROM pg_index i WHERE i.indrelid = to_regclass('app.pages')`.execute(app);
  expect(indexes.rows).toEqual([{ primary: true, valid: true, ready: true }]);
});

it('[AC-F1-09n#17] scheduled_at stores the supplied instant without consulting SQL time', async () => {
  const { page, slot } = await seeded(app);
  expect(await insert(app, 'pages', { ...page, ...slot })).toMatchObject({ scheduled_at: AT });
  const changed = new Date('2027-01-01T01:23:45.000Z');
  expect(await update(app, page, { scheduled_at: changed })).toMatchObject({ scheduled_at: changed });
});

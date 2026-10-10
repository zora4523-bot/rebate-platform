// F1-06n brief §9.2 is the database contract. BR-TEXT-24 publication policy, the
// 24-hour Clock calculation and key enumeration belong to the application layer.
// No migration-name assumptions: the integration harness applies all migrations.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, foreignKeys, keys, newAdmin } from '../../admin/kit.ts';
import { CHECK_VIOLATION, UNIQUE_VIOLATION, sqlState, unique } from '../kit.ts';

const ICONS = 'platform_icons';
const VERSIONS = 'platform_icon_versions';
const UPLOADS = 'platform_icon_uploads';
const TABLES = [ICONS, VERSIONS, UPLOADS] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown>;
type Shape = Record<string, readonly [type: string, nullable: boolean, defaulted: boolean]>;
const SHAPES: Record<Table, Shape> = {
  platform_icons: {
    app_id: ['text', false, false],
    key: ['text', false, false],
    current_version: ['int4', true, false],
    revision: ['int4', false, true],
    updated_by: ['text', true, false],
    updated_by_admin_id: ['uuid', true, false],
    updated_at: ['timestamptz', true, false],
  },
  platform_icon_versions: {
    app_id: ['text', false, false],
    key: ['text', false, false],
    version: ['int4', false, false],
    upload_id: ['uuid', false, false],
    sha256: ['text', false, false],
    format: ['text', false, false],
    bytes: ['int4', false, false],
    sanitized: ['bool', false, false],
    source_url: ['text', true, false],
    downloaded_on: ['date', true, false],
    ever_published: ['bool', false, true],
    revision: ['int4', false, true],
    created_by: ['text', false, false],
    created_by_admin_id: ['uuid', false, false],
    created_at: ['timestamptz', false, true],
  },
  platform_icon_uploads: {
    id: ['uuid', false, false],
    app_id: ['text', false, false],
    key: ['text', false, false],
    sha256: ['text', false, false],
    format: ['text', false, false],
    bytes: ['int4', false, false],
    sanitized: ['bool', false, false],
    created_by_admin_id: ['uuid', false, false],
    created_at: ['timestamptz', false, true],
    expires_at: ['timestamptz', false, false],
  },
};
const AT = new Date('2026-10-10T00:00:00Z');
const EXPIRES = new Date('2026-10-11T00:00:00Z');
const SHA = '0123456789abcdef'.repeat(4);
const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
let database: TestDatabase;
let app: Kysely<DB>;
const connections = new Map<(typeof ROLES)[number], Kysely<DB>>();

beforeAll(async () => {
  database = await createTestDatabase();
  for (const role of ROLES) {
    connections.set(role, createDb({ connectionString: database.urlFor(role), max: 2 }));
  }
  app = connections.get('couli_app')!;
});

afterAll(async () => {
  await Promise.all([...connections.values()].map((db) => destroyDb(db)));
  await database?.drop();
});

// Called inside each test before any table access. Missing tables/columns must
// fail assertions, never an INSERT, an undefined-column error or a regclass cast.
async function ready(): Promise<void> {
  for (const table of TABLES) {
    const names = (await columns(app, table)).map((c) => c.name);
    for (const name of Object.keys(SHAPES[table])) {
      expect(names, `${table}.${name} exists`).toContain(name);
    }
  }
}

async function insert(db: Kysely<DB>, table: Table, row: Row): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function rows() {
  await ready();
  const appId = unique('icons');
  const admin = await newAdmin(app, { app_id: appId });
  const common = {
    app_id: appId,
    key: 'taobao',
    sha256: SHA,
    format: 'svg',
    bytes: 1,
    sanitized: false,
    created_by_admin_id: admin.id,
    created_at: AT,
  };
  const upload: Row = { ...common, id: randomUUID(), expires_at: EXPIRES };
  const version: Row = {
    ...common,
    version: 1,
    upload_id: upload.id,
    created_by: admin.login_name,
    source_url: null,
    downloaded_on: null,
  };
  const icon: Row = {
    app_id: appId,
    key: 'taobao',
    current_version: null,
    updated_by: null,
    updated_by_admin_id: null,
    updated_at: null,
  };
  return { upload, version, icon, admin };
}

async function seeded() {
  const data = await rows();
  await insert(app, UPLOADS, data.upload);
  await insert(app, VERSIONS, data.version);
  await insert(app, ICONS, data.icon);
  return data;
}

async function expectCheck(run: Promise<unknown>, constraint: string): Promise<void> {
  await expect(run).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
}

it('[AC-F1-06n#1] all three tables have the specified types, nullability and defaults', async () => {
  await ready();
  for (const table of TABLES) {
    const actual = await columns(app, table);
    expect(actual.map((c) => c.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const [name, [type, nullable, defaulted]] of Object.entries(SHAPES[table])) {
      expect(
        actual.find((c) => c.name === name),
        `${table}.${name}`,
      ).toEqual({
        name,
        type,
        nullable,
        defaulted,
      });
    }
  }
});

it('[AC-F1-06n#2] omitted defaults produce revision 0/1, false and transaction time', async () => {
  const data = await rows();
  delete data.upload.created_at;
  // The database clock is allowed for created_at only; no test-machine clock.
  delete data.version.created_at;
  await app.transaction().execute(async (trx) => {
    const time = await sql<{ now: Date; expires: Date }>`
      SELECT now() AS now, now() + interval '24 hours' AS expires
    `.execute(trx);
    const upload = await insert(trx, UPLOADS, {
      ...data.upload,
      expires_at: time.rows[0]!.expires,
    });
    const version = await insert(trx, VERSIONS, data.version);
    const icon = await insert(trx, ICONS, { app_id: data.icon.app_id, key: data.icon.key });
    expect(upload.created_at).toEqual(time.rows[0]!.now);
    expect(upload.expires_at).toEqual(time.rows[0]!.expires);
    expect(version).toMatchObject({
      revision: 1,
      ever_published: false,
      created_at: time.rows[0]!.now,
      source_url: null,
      downloaded_on: null,
    });
    expect(icon).toMatchObject({
      revision: 0,
      current_version: null,
      updated_by: null,
      updated_by_admin_id: null,
      updated_at: null,
    });
  });
});

it('[AC-F1-06n#3] icon key CHECK enforces lowercase/underscore length 1 through 32', async () => {
  const { icon } = await rows();
  for (const key of ['', 'TaoBao', 'jd1', 'wechat-pay', 'a b', '淘', 'a'.repeat(33), 'jd\n']) {
    await expectCheck(insert(app, ICONS, { ...icon, key }), 'platform_icons_key_check');
  }
  // The database checks syntax, not the application's current enum whitelist.
  for (const key of [
    'a',
    '_',
    'a'.repeat(32),
    'taobao',
    'tmall',
    'jd',
    'pdd',
    'wechat',
    'wechat_pay',
    'alipay',
    'wecom',
    'future_platform',
  ]) {
    expect(await sqlState(insert(app, ICONS, { ...icon, key })), key).toBe('no error');
  }
});

it('[AC-F1-06n#4] icon revision CHECK rejects negatives and accepts zero and positive values', async () => {
  const { icon } = await rows();
  await expectCheck(insert(app, ICONS, { ...icon, revision: -1 }), 'platform_icons_revision_check');
  for (const revision of [0, 1, 2147483647]) {
    const stored = await insert(app, ICONS, { ...icon, app_id: unique('rev'), revision });
    expect(stored.revision).toBe(revision);
  }
});

it('[AC-F1-06n#5] version and version revision CHECKs have lower bound one', async () => {
  const { upload, version } = await rows();
  await insert(app, UPLOADS, upload);
  for (const name of ['version', 'revision']) {
    for (const bad of [0, -1]) {
      await expectCheck(
        insert(app, VERSIONS, { ...version, [name]: bad }),
        `platform_icon_versions_${name}_check`,
      );
    }
  }
  const stored = await insert(app, VERSIONS, { ...version, revision: 1 });
  expect(stored).toMatchObject({ version: 1, revision: 1 });
});

it('[AC-F1-06n#6] both media tables enforce named SHA-256, format and positive bytes CHECKs', async () => {
  const data = await rows();
  await insert(app, UPLOADS, data.upload);
  const invalid: [string, unknown[]][] = [
    ['sha256', ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${SHA}\n`]],
    ['format', ['', 'SVG', 'jpeg', 'webp']],
    ['bytes', [0, -1]],
  ];
  for (const table of [UPLOADS, VERSIONS] as const) {
    const row = table === UPLOADS ? { ...data.upload, id: randomUUID() } : data.version;
    for (const [name, values] of invalid) {
      for (const bad of values) {
        await expectCheck(insert(app, table, { ...row, [name]: bad }), `${table}_${name}_check`);
      }
    }
  }
  for (const format of ['svg', 'png']) {
    const id = randomUUID();
    const upload = await insert(app, UPLOADS, { ...data.upload, id, format, sanitized: true });
    const version = await insert(app, VERSIONS, {
      ...data.version,
      version: format === 'svg' ? 1 : 2,
      upload_id: id,
      format,
      sanitized: true,
    });
    expect(upload).toMatchObject({ sha256: SHA, format, bytes: 1, sanitized: true });
    expect(version).toMatchObject({ sha256: SHA, format, bytes: 1, sanitized: true });
  }
});

it('[AC-F1-06n#7] expiry is mandatory and strictly later than creation with no default', async () => {
  const { upload } = await rows();
  for (const expires_at of [AT, new Date('2026-10-09T23:59:59Z')]) {
    await expectCheck(
      insert(app, UPLOADS, { ...upload, expires_at }),
      'platform_icon_uploads_expiry_check',
    );
  }
  const missing = { ...upload };
  delete missing.expires_at;
  expect(await sqlState(insert(app, UPLOADS, missing))).toBe('23502');
  // SQL only enforces order; the injected application Clock supplies the 24-hour TTL.
  const immediate = new Date('2026-10-10T00:00:00.001Z');
  const stored = await insert(app, UPLOADS, { ...upload, expires_at: immediate });
  expect(stored.expires_at).toEqual(immediate);
  const day = await insert(app, UPLOADS, { ...upload, id: randomUUID() });
  expect(day).toMatchObject({ created_at: AT, expires_at: EXPIRES });
});

it('[AC-F1-06n#8] declared primary keys and global upload id uniqueness have exact columns', async () => {
  await ready();
  for (const [table, expected] of [
    [ICONS, ['app_id', 'key']],
    [VERSIONS, ['app_id', 'key', 'version']],
    [UPLOADS, ['id']],
  ] as const) {
    expect((await keys(app, table)).filter((k) => k.primary)).toEqual([
      { columns: [...expected], primary: true, partial: false, expression: false },
    ]);
  }
  const constraint = await sql<{ columns: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${VERSIONS}
      AND c.contype = 'u' AND c.conname = 'platform_icon_versions_upload_id_key'
  `.execute(app);
  expect(constraint.rows).toEqual([{ columns: ['upload_id'] }]);
});

it('[AC-F1-06n#9] duplicate primary keys and reuse of any upload are rejected with 23505', async () => {
  const data = await seeded();
  expect(await sqlState(insert(app, ICONS, data.icon))).toBe(UNIQUE_VIOLATION);
  expect(await sqlState(insert(app, UPLOADS, data.upload))).toBe(UNIQUE_VIOLATION);
  const otherId = randomUUID();
  await insert(app, UPLOADS, { ...data.upload, id: otherId });
  // A different upload isolates the composite primary key from the upload-id UNIQUE.
  expect(await sqlState(insert(app, VERSIONS, { ...data.version, upload_id: otherId }))).toBe(
    UNIQUE_VIOLATION,
  );
  for (const change of [{ version: 2 }, { key: 'jd' }, { app_id: unique('other') }]) {
    await expect(insert(app, VERSIONS, { ...data.version, ...change })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'platform_icon_versions_upload_id_key',
    });
  }
});

it('[AC-F1-06n#10] separate tenants, keys and version numbers can reuse their local identity', async () => {
  const data = await seeded();
  for (const change of [{ version: 2 }, { key: 'jd' }, { app_id: unique('other') }]) {
    const id = randomUUID();
    await insert(app, UPLOADS, {
      ...data.upload,
      id,
      ...('key' in change ? { key: change.key } : {}),
      ...('app_id' in change ? { app_id: change.app_id } : {}),
    });
    const version = await insert(app, VERSIONS, { ...data.version, ...change, upload_id: id });
    expect(version).toMatchObject(change);
    if ('version' in change) continue;
    const icon = await insert(app, ICONS, { ...data.icon, ...change, current_version: 1 });
    expect(icon).toMatchObject({ ...change, current_version: 1 });
  }
});

it('[AC-F1-06n#11] foreign keys target the specified columns without cascading actions', async () => {
  await ready();
  const expected = {
    platform_icons: [
      { columns: ['updated_by_admin_id'], target: 'admin_users', targetColumns: ['id'] },
      {
        columns: ['app_id', 'key', 'current_version'],
        target: VERSIONS,
        targetColumns: ['app_id', 'key', 'version'],
      },
    ],
    platform_icon_versions: [
      { columns: ['created_by_admin_id'], target: 'admin_users', targetColumns: ['id'] },
      { columns: ['upload_id'], target: UPLOADS, targetColumns: ['id'] },
    ],
    platform_icon_uploads: [
      { columns: ['created_by_admin_id'], target: 'admin_users', targetColumns: ['id'] },
    ],
  };
  for (const table of TABLES) {
    const actual = await foreignKeys(app, table);
    expect(actual).toHaveLength(expected[table].length);
    for (const fk of expected[table]) {
      const found = actual.find((f) => f.columns.join(',') === fk.columns.join(','));
      expect(found).toMatchObject({ ...fk, targetSchema: 'app', validated: true });
      expect(['a', 'r']).toContain(found!.onDelete);
      expect(['a', 'r']).toContain(found!.onUpdate);
    }
  }
  const match = await sql<{ match: string }>`
    SELECT f.confmatchtype::text AS match FROM pg_constraint f
    JOIN pg_class t ON t.oid = f.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class target ON target.oid = f.confrelid
    WHERE n.nspname = 'app' AND t.relname = ${ICONS} AND target.relname = ${VERSIONS}
      AND f.contype = 'f'
  `.execute(app);
  expect(match.rows).toEqual([{ match: 's' }]);
});

it('[AC-F1-06n#12] missing admins or uploads fail with 23503 and valid references succeed', async () => {
  const data = await rows();
  expect(
    await sqlState(insert(app, UPLOADS, { ...data.upload, created_by_admin_id: randomUUID() })),
  ).toBe('23503');
  await insert(app, UPLOADS, data.upload);
  expect(
    await sqlState(insert(app, VERSIONS, { ...data.version, created_by_admin_id: randomUUID() })),
  ).toBe('23503');
  expect(await sqlState(insert(app, VERSIONS, { ...data.version, upload_id: randomUUID() }))).toBe(
    '23503',
  );
  expect(
    await sqlState(insert(app, ICONS, { ...data.icon, updated_by_admin_id: randomUUID() })),
  ).toBe('23503');
  expect(await sqlState(insert(app, VERSIONS, data.version))).toBe('no error');
  expect(
    await sqlState(
      insert(app, ICONS, {
        ...data.icon,
        updated_by_admin_id: data.admin.id,
        updated_by: data.admin.login_name,
        current_version: 1,
        updated_at: AT,
      }),
    ),
  ).toBe('no error');
});

it('[AC-F1-06n#13] current version cannot reference a missing, foreign-tenant or foreign-key version', async () => {
  const data = await seeded();
  expect(
    await sqlState(
      sql`UPDATE app.platform_icons SET current_version = 2
    WHERE app_id = ${data.icon.app_id} AND key = 'taobao'`.execute(app),
    ),
  ).toBe('23503');
  expect(await sqlState(insert(app, ICONS, { ...data.icon, key: 'jd', current_version: 1 }))).toBe(
    '23503',
  );
  expect(
    await sqlState(
      insert(app, ICONS, { ...data.icon, app_id: unique('other'), current_version: 1 }),
    ),
  ).toBe('23503');
  expect(
    await sqlState(
      sql`UPDATE app.platform_icons SET current_version = 1
    WHERE app_id = ${data.icon.app_id} AND key = 'taobao'`.execute(app),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.platform_icons SET current_version = NULL
    WHERE app_id = ${data.icon.app_id} AND key = 'taobao'`.execute(app),
    ),
  ).toBe('no error');
  expect(await sqlState(insert(app, ICONS, { ...data.icon, key: 'jd' }))).toBe('no error');
});

it('[AC-F1-06n#14] app can read all tables and update icon publication and version registration columns', async () => {
  const data = await seeded();
  for (const table of TABLES) {
    const result = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${data.icon.app_id}`.execute(app);
    expect(result.rows).toHaveLength(1);
  }
  const version = await sql<Row>`UPDATE app.platform_icon_versions
    SET source_url = 'https://example.com/brand', downloaded_on = DATE '2026-10-09',
        revision = revision + 1, ever_published = true
    WHERE app_id = ${data.icon.app_id} AND key = 'taobao' AND version = 1
    RETURNING source_url, downloaded_on::text, revision, ever_published`.execute(app);
  expect(version.rows).toEqual([
    {
      source_url: 'https://example.com/brand',
      downloaded_on: '2026-10-09',
      revision: 2,
      ever_published: true,
    },
  ]);
  const published = await sql<Row>`UPDATE app.platform_icons
    SET current_version = 1, revision = revision + 1, updated_by = ${data.admin.login_name},
        updated_by_admin_id = ${data.admin.id}, updated_at = ${AT}
    WHERE app_id = ${data.icon.app_id} AND key = 'taobao' RETURNING *`.execute(app);
  expect(published.rows).toEqual([
    {
      ...data.icon,
      current_version: 1,
      revision: 1,
      updated_by: data.admin.login_name,
      updated_by_admin_id: data.admin.id,
      updated_at: AT,
    },
  ]);
});

it('[AC-F1-06n#15] app cannot update immutable version columns, any upload column, or delete rows', async () => {
  await seeded();
  const mutable = ['source_url', 'downloaded_on', 'revision', 'ever_published'];
  for (const table of [VERSIONS, UPLOADS] as const) {
    for (const name of Object.keys(SHAPES[table])) {
      if (table === VERSIONS && mutable.includes(name)) continue;
      // Even a zero-row/no-op update needs the column privilege; constraints cannot mask it.
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)}
        SET ${sql.ref(name)} = ${sql.ref(name)} WHERE false`.execute(app),
        ),
        `${table}.${name}`,
      ).toBe('42501');
    }
  }
  for (const table of TABLES) {
    expect(
      await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE false`.execute(app)),
      table,
    ).toBe('42501');
  }
});

it('[AC-F1-06n#16] readonly can SELECT every column and cannot INSERT, UPDATE or DELETE', async () => {
  const data = await seeded();
  const readonly = connections.get('couli_readonly')!;
  for (const [table, row] of [
    [ICONS, data.icon],
    [VERSIONS, data.version],
    [UPLOADS, data.upload],
  ] as const) {
    const read = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${data.icon.app_id}`.execute(readonly);
    expect(read.rows).toHaveLength(1);
    expect(await sqlState(insert(readonly, table, row)), table).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE ${sql.table(`app.${table}`)} SET key = key WHERE false`.execute(readonly),
      ),
      table,
    ).toBe('42501');
    expect(
      await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE false`.execute(readonly)),
      table,
    ).toBe('42501');
  }
});

it('[AC-F1-06n#17] payout and maintenance have no access to any platform icon table', async () => {
  const data = await seeded();
  for (const role of ['couli_payout', 'couli_maint'] as const) {
    const db = connections.get(role)!;
    for (const [table, row] of [
      [ICONS, data.icon],
      [VERSIONS, data.version],
      [UPLOADS, data.upload],
    ] as const) {
      expect(
        await sqlState(sql`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(db)),
        `${role}.${table}`,
      ).toBe('42501');
      expect(await sqlState(insert(db, table, row)), `${role}.${table}`).toBe('42501');
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET key = key WHERE false`.execute(db),
        ),
      ).toBe('42501');
      expect(
        await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE false`.execute(db)),
      ).toBe('42501');
    }
  }
});

it('[AC-F1-06n#18] effective grants are exact, including every column and non-DML privileges', async () => {
  await ready();
  for (const role of ROLES) {
    const db = connections.get(role)!;
    for (const table of TABLES) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const result = await sql<{ allowed: boolean }>`
          SELECT has_table_privilege(current_user, c.oid, ${privilege}) AS allowed
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ${table}
        `.execute(db);
        const allowed =
          (role === 'couli_app' &&
            (privilege === 'SELECT' ||
              privilege === 'INSERT' ||
              (table === ICONS && privilege === 'UPDATE'))) ||
          (role === 'couli_readonly' && privilege === 'SELECT');
        expect(result.rows, `${role}.${table}.${privilege}`).toEqual([{ allowed }]);
      }
      for (const name of Object.keys(SHAPES[table])) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const result = await sql<{ allowed: boolean }>`
            SELECT has_column_privilege(current_user, c.oid, a.attnum, ${privilege}) AS allowed
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relname = ${table} AND a.attname = ${name}
          `.execute(db);
          const allowed =
            (role === 'couli_app' &&
              (privilege === 'SELECT' ||
                privilege === 'INSERT' ||
                (privilege === 'UPDATE' &&
                  (table === ICONS ||
                    (table === VERSIONS &&
                      ['source_url', 'downloaded_on', 'revision', 'ever_published'].includes(
                        name,
                      )))))) ||
            (role === 'couli_readonly' && privilege === 'SELECT');
          expect(result.rows, `${role}.${table}.${name}.${privilege}`).toEqual([{ allowed }]);
        }
      }
    }
  }
});

it('[AC-F1-06n#19] platform icon tables have no application triggers', async () => {
  await ready();
  const triggers = await sql<{ name: string }>`
    SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname IN (${sql.join(TABLES)}) AND NOT t.tgisinternal
  `.execute(app);
  expect(triggers.rows).toEqual([]);
});

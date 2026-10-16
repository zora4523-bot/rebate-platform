// B1-02w §9: 04 §3.2 / BR-ID-04 storage only; no third-party or login orchestration.
// The existing test factory applies migrations before cloning. Old-row preservation is
// therefore checked against the migration source; old-writer compatibility is exercised below.
// Assert new columns first so the pre-migration baseline fails assertions, not undefined-column SQL.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  columns,
  hex64,
  insertRow,
  newUser,
  sqlState,
  useDb,
} from '../../identity-sessions/kit.ts';

const OAUTH_CHECK = 'user_oauth_apple_refresh_token_provider_check';
const SESSION_CHECK = 'sessions_login_method_check';
const AT = new Date('2026-10-16T08:30:00.123+08:00');
// Opaque binary fixture, never an actual token or a simulated platform response.
const CIPHER = Buffer.from([0, 255, 128, 1, 92, 0, 42]);
const TABLES = ['user_oauth', 'sessions'] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown>;
let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, readonly].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

async function ready() {
  for (const [table, name] of [
    ['user_oauth', 'apple_refresh_token_cipher'],
    ['user_oauth', 'revoked_at'],
    ['sessions', 'login_method'],
  ] as const) {
    expect(
      (await columns(table)).map((column) => column.name),
      `${table}.${name}`,
    ).toContain(name);
  }
}

async function insert(db: Kysely<DB>, table: Table, row: Row) {
  const names = Object.keys(row);
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
}

async function oauth(provider = 'apple'): Promise<Row> {
  return {
    id: randomUUID(),
    app_id: 'couli',
    user_id: await newUser(),
    provider,
    union_id: randomUUID(),
    open_id: randomUUID(),
    created_at: AT,
    updated_at: AT,
  };
}

async function session(): Promise<Row> {
  const userId = await newUser();
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: 'couli',
    user_id: userId,
    device_hash: hex64(),
    id_source: 'idfv',
    install_secret_cipher: Buffer.from('fixture-encrypted-secret'),
  });
  return {
    id: randomUUID(),
    app_id: 'couli',
    sid: randomUUID(),
    user_id: userId,
    device_id: deviceId,
    created_at: AT,
    updated_at: AT,
  };
}

it('[AC-B1-02w#1] three new columns have exact types, allow NULL and have no defaults', async () => {
  await ready();
  for (const [table, name, type] of [
    ['user_oauth', 'apple_refresh_token_cipher', 'bytea'],
    ['user_oauth', 'revoked_at', 'timestamptz'],
    ['sessions', 'login_method', 'text'],
  ] as const) {
    expect((await columns(table)).find((column) => column.name === name)).toEqual({
      name,
      type,
      nullable: true,
      hasDefault: false,
    });
  }
});

it('[AC-B1-02w#2] existing columns retain their types, nullability and defaults', async () => {
  await ready();
  const common = [
    ['id', 'uuid', false, false],
    ['app_id', 'text', false, false],
    ['user_id', 'uuid', false, false],
    ['created_at', 'timestamptz', false, true],
    ['updated_at', 'timestamptz', false, true],
  ] as const;
  const baseline = {
    user_oauth: [
      ...common,
      ['provider', 'text', false, false],
      ['union_id', 'text', false, false],
      ['open_id', 'text', true, false],
      ['merged_from_user_id', 'uuid', true, false],
      ['row_version', 'int4', false, true],
    ],
    sessions: [
      ...common,
      ['sid', 'text', false, false],
      ['device_id', 'uuid', false, false],
      ['revoked_at', 'timestamptz', true, false],
      ['revoke_reason', 'text', true, false],
    ],
  };
  for (const table of TABLES) {
    const actual = await columns(table);
    expect(actual).toHaveLength(baseline[table].length + (table === 'user_oauth' ? 2 : 1));
    for (const [name, type, nullable, hasDefault] of baseline[table]) {
      expect(
        actual.find((column) => column.name === name),
        `${table}.${String(name)}`,
      ).toEqual({
        name,
        type,
        nullable,
        hasDefault,
      });
    }
    const defaults = await sql<{ name: string; value: string }>`
      SELECT column_name AS name, column_default AS value FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table} AND column_default IS NOT NULL
      ORDER BY column_name`.execute(app);
    expect(defaults.rows).toEqual(
      table === 'user_oauth'
        ? [
            { name: 'created_at', value: 'now()' },
            { name: 'row_version', value: '0' },
            { name: 'updated_at', value: 'now()' },
          ]
        : [
            { name: 'created_at', value: 'now()' },
            { name: 'updated_at', value: 'now()' },
          ],
    );
  }
});

it('[AC-B1-02w#3] existing constraints stay intact and both named CHECKs are validated', async () => {
  await ready();
  const baseline: Record<Table, Record<string, string>> = {
    user_oauth: {
      user_oauth_pkey: 'PRIMARY KEY (id)',
      user_oauth_provider_check:
        "CHECK ((provider = ANY (ARRAY['wechat'::text, 'apple'::text, 'huawei'::text])))",
      user_oauth_identity_key: 'UNIQUE (app_id, provider, union_id)',
      user_oauth_user_provider_key: 'UNIQUE (app_id, user_id, provider)',
      user_oauth_user_fkey: 'FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id)',
      user_oauth_merged_from_fkey:
        'FOREIGN KEY (app_id, merged_from_user_id) REFERENCES app.users(app_id, id)',
    },
    sessions: {
      sessions_pkey: 'PRIMARY KEY (id)',
      sessions_sid_key: 'UNIQUE (app_id, sid)',
      sessions_user_fkey: 'FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id)',
      sessions_device_fkey: 'FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id)',
    },
  };
  for (const table of TABLES) {
    // Fix deparser search_path so FK output is schema-qualified on every connection.
    const result = await app.transaction().execute(async (tx) => {
      await sql`SET LOCAL search_path = pg_catalog`.execute(tx);
      return sql<{
        name: string;
        kind: string;
        definition: string;
        validated: boolean;
        deferred: boolean;
      }>`
        SELECT conname AS name, contype::text AS kind, pg_get_constraintdef(oid) AS definition,
               convalidated AS validated, condeferrable AS deferred
        FROM pg_constraint WHERE conrelid = to_regclass(${`app.${table}`})
          AND contype IN ('p', 'u', 'f', 'c')`.execute(tx);
    });
    expect(result.rows).toHaveLength(Object.keys(baseline[table]).length + 1);
    for (const [name, definition] of Object.entries(baseline[table])) {
      expect(result.rows.find((row) => row.name === name)).toMatchObject({
        definition,
        validated: true,
        deferred: false,
      });
    }
    const name = table === 'user_oauth' ? OAUTH_CHECK : SESSION_CHECK;
    expect(result.rows.find((row) => row.name === name)).toMatchObject({
      kind: 'c',
      validated: true,
      deferred: false,
    });
  }
});

it('[AC-B1-02w#4] Apple ciphertext round-trips as bytes and other providers reject it on INSERT', async () => {
  await ready();
  const row = await oauth();
  const inserted = await insert(app, 'user_oauth', { ...row, apple_refresh_token_cipher: CIPHER });
  expect(inserted.rows).toEqual([
    expect.objectContaining({
      id: row['id'],
      apple_refresh_token_cipher: CIPHER,
      revoked_at: null,
    }),
  ]);
  for (const provider of ['wechat', 'huawei']) {
    await expect(
      insert(app, 'user_oauth', {
        ...(await oauth(provider)),
        apple_refresh_token_cipher: CIPHER,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: OAUTH_CHECK });
  }
});

it('[AC-B1-02w#5] provider restriction also rejects UPDATE of either ciphertext or provider', async () => {
  await ready();
  for (const provider of ['wechat', 'huawei']) {
    const row = await oauth(provider);
    await insert(app, 'user_oauth', row);
    await expect(
      sql`UPDATE app.user_oauth SET apple_refresh_token_cipher = ${CIPHER}
      WHERE id = ${row['id']}`.execute(app),
    ).rejects.toMatchObject({ code: '23514', constraint: OAUTH_CHECK });
  }
  const row = await oauth();
  await insert(app, 'user_oauth', { ...row, apple_refresh_token_cipher: CIPHER });
  for (const provider of ['wechat', 'huawei']) {
    await expect(
      sql`UPDATE app.user_oauth SET provider = ${provider}
      WHERE id = ${row['id']}`.execute(app),
    ).rejects.toMatchObject({ code: '23514', constraint: OAUTH_CHECK });
  }
});

it('[AC-B1-02w#6] all providers accept NULL ciphertext and revoked_at has no provider restriction', async () => {
  await ready();
  for (const provider of ['wechat', 'apple', 'huawei']) {
    const inserted = await insert(app, 'user_oauth', {
      ...(await oauth(provider)),
      apple_refresh_token_cipher: null,
      revoked_at: AT,
    });
    expect(inserted.rows[0]).toMatchObject({
      provider,
      apple_refresh_token_cipher: null,
      revoked_at: AT,
    });
  }
});

it('[AC-B1-02w#7] every permitted login method and explicit NULL can be inserted by couli_app', async () => {
  await ready();
  for (const login_method of ['sms', 'wechat', 'apple', 'huawei', 'merge', null]) {
    const inserted = await insert(app, 'sessions', { ...(await session()), login_method });
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]?.['login_method']).toBe(login_method);
  }
});

it('[AC-B1-02w#8] unsupported, empty and case/whitespace-variant login methods fail the named CHECK', async () => {
  await ready();
  const row = await session();
  for (const login_method of ['password', '', 'Apple', 'SMS', ' apple', 'apple ', 'refresh']) {
    await expect(insert(app, 'sessions', { ...row, login_method })).rejects.toMatchObject({
      code: '23514',
      constraint: SESSION_CHECK,
    });
  }
});

it('[AC-B1-02w#9] old INSERT statements omit the new columns and persist NULL without rewriting old values', async () => {
  await ready();
  for (const provider of ['wechat', 'apple', 'huawei']) {
    const row = await oauth(provider);
    await insert(app, 'user_oauth', row);
    const read = await sql<Row>`SELECT * FROM app.user_oauth WHERE id = ${row['id']}`.execute(app);
    expect(read.rows).toEqual([
      expect.objectContaining({
        ...row,
        apple_refresh_token_cipher: null,
        revoked_at: null,
      }),
    ]);
  }
  const row = await session();
  await insert(app, 'sessions', row);
  const read = await sql<Row>`SELECT * FROM app.sessions WHERE id = ${row['id']}`.execute(app);
  expect(read.rows).toEqual([expect.objectContaining({ ...row, login_method: null })]);
});

it('[AC-B1-02w#10] login_method is immutable for couli_app, including attempts to set or clear NULL', async () => {
  await ready();
  for (const original of ['apple', null]) {
    const row = await session();
    await insert(app, 'sessions', { ...row, login_method: original });
    for (const replacement of ['sms', null]) {
      expect(
        await sqlState(
          sql`UPDATE app.sessions SET login_method = ${replacement}
        WHERE id = ${row['id']}`.execute(app),
        ),
      ).toBe('42501');
    }
    const read =
      await sql<Row>`SELECT login_method FROM app.sessions WHERE id = ${row['id']}`.execute(app);
    expect(read.rows).toEqual([{ login_method: original }]);
  }
});

it('[AC-B1-02w#11] session revocation remains writable and leaves login_method unchanged', async () => {
  await ready();
  const row = await session();
  await insert(app, 'sessions', { ...row, login_method: 'apple' });
  const revoked = await sql<Row>`UPDATE app.sessions
    SET revoked_at = ${AT}, revoke_reason = 'fixture-revocation', updated_at = ${AT}
    WHERE id = ${row['id']} RETURNING login_method, revoked_at, revoke_reason, updated_at`.execute(
    app,
  );
  expect(revoked.rows).toEqual([
    {
      login_method: 'apple',
      revoked_at: AT,
      revoke_reason: 'fixture-revocation',
      updated_at: AT,
    },
  ]);
});

it('[AC-B1-02w#12] Apple revocation and reauthorization update the same retained binding', async () => {
  await ready();
  const row = await oauth();
  await insert(app, 'user_oauth', { ...row, apple_refresh_token_cipher: CIPHER });
  const nextCipher = Buffer.from([128, 0, 255, 2]);
  for (const [revokedAt, cipher] of [
    [AT, null],
    [null, nextCipher],
    [null, null],
  ] as const) {
    const updated = await sql<Row>`UPDATE app.user_oauth
      SET revoked_at = ${revokedAt}, apple_refresh_token_cipher = ${cipher}
      WHERE id = ${row['id']} RETURNING *`.execute(app);
    expect(updated.rows).toEqual([
      expect.objectContaining({
        ...row,
        revoked_at: revokedAt,
        apple_refresh_token_cipher: cipher,
      }),
    ]);
    const read = await sql<Row>`SELECT revoked_at, apple_refresh_token_cipher FROM app.user_oauth
      WHERE id = ${row['id']}`.execute(app);
    expect(read.rows).toEqual([{ revoked_at: revokedAt, apple_refresh_token_cipher: cipher }]);
  }
});

it('[AC-B1-02w#13] readonly can read all new columns but cannot insert either table', async () => {
  await ready();
  const oauthRow: Row = { ...(await oauth()), apple_refresh_token_cipher: CIPHER, revoked_at: AT };
  const sessionRow: Row = { ...(await session()), login_method: 'apple' };
  await insert(app, 'user_oauth', oauthRow);
  await insert(app, 'sessions', sessionRow);
  const token = await sql<Row>`SELECT apple_refresh_token_cipher, revoked_at FROM app.user_oauth
    WHERE id = ${oauthRow['id']}`.execute(readonly);
  expect(token.rows).toEqual([{ apple_refresh_token_cipher: CIPHER, revoked_at: AT }]);
  const method = await sql<Row>`SELECT login_method FROM app.sessions
    WHERE id = ${sessionRow['id']}`.execute(readonly);
  expect(method.rows).toEqual([{ login_method: 'apple' }]);
  for (const [table, row] of [
    ['user_oauth', oauthRow],
    ['sessions', sessionRow],
  ] as const) {
    expect(await sqlState(insert(readonly, table, { ...row, id: randomUUID() }))).toBe('42501');
  }
});

it('[AC-B1-02w#14] neither table gains an application trigger', async () => {
  await ready();
  const triggers = await sql<{ name: string }>`SELECT tgname AS name FROM pg_trigger
    WHERE tgrelid IN ('app.user_oauth'::regclass, 'app.sessions'::regclass)
      AND NOT tgisinternal`.execute(app);
  expect(triggers.rows).toEqual([]);
});

it('[AC-B1-02w#15] migration preserves existing rows and introduces no privilege changes or triggers', () => {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  // Allow only the documented renumbering if 0033 is occupied before this task lands.
  const files = readdirSync(directory).filter((file) =>
    /^\d{4}_oauth-session-columns\.sql$/.test(file),
  );
  expect(files).toHaveLength(1);
  const source = readFileSync(new URL(files[0]!, directory), 'utf8');
  expect(source.split(/\r?\n/)[0]).toBe('-- Up Migration');
  expect(source).not.toMatch(/^\s*--\s*Down Migration/im);
  // This migration is plain SQL by task ruling: no procedural/dynamic SQL hiding writes.
  const sqlOnly = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/'(?:''|[^'])*'/g, "''");
  expect(sqlOnly).not.toMatch(
    /\b(?:UPDATE|INSERT|DELETE|MERGE|TRUNCATE|COPY|DO|CALL|EXECUTE|GRANT|REVOKE|CREATE|DROP|RENAME)\b/i,
  );
  expect(sqlOnly).not.toMatch(/\bALTER\s+COLUMN\b/i);
  expect(sqlOnly).toMatch(/\bALTER\s+TABLE\s+app\.user_oauth\b/i);
  expect(sqlOnly).toMatch(/\bALTER\s+TABLE\s+app\.sessions\b/i);
});

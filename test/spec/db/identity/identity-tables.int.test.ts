// Rule tests for the identity baseline tables of B1-02a (规划/04 §3.2 rows devices, users,
// user_oauth, login_logs, device_registrations; 08 BR-ID-05 细则「同设备注册上限的计数」,
// BR-ID-06, BR-ID-09 细则「设备标识的无效值」, BR-INV-05). Real PostgreSQL, connected as the
// business role couli_app (the identity module writes these tables as it).
//
// 04 fixes only some value sets of these tables (status: deleting / deleted besides the normal
// value; login_logs.method: merge besides the others). Columns whose shape 04 leaves to the
// implementation are filled by `insertRow` from the catalog: a NOT NULL column without a default
// gets a value of its type, or the first literal of the CHECK constraint that lists its values.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

let database: TestDatabase;
let app: Kysely<DB>;
let seq = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

/** Resolves to the SQLSTATE of the rejection, or 'no error' when the statement succeeds. */
async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

function unique(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq)}x${randomUUID().slice(0, 8)}`;
}

function hex64(): string {
  return (randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')).slice(0, 64);
}

type Column = { name: string; type: string; nullable: boolean; hasDefault: boolean };

const columnCache = new Map<string, Column[]>();

async function columns(table: string): Promise<Column[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = await sql<{ name: string; type: string; nullable: string; has_default: boolean }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
           (column_default IS NOT NULL OR is_identity = 'YES' OR is_generated = 'ALWAYS')
             AS has_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY ordinal_position
  `.execute(app);
  const list = rows.rows.map((r) => ({
    name: r.name,
    type: r.type,
    nullable: r.nullable === 'YES',
    hasDefault: r.has_default,
  }));
  columnCache.set(table, list);
  return list;
}

/** First string literal listed by a CHECK constraint that mentions the column, if any. */
async function checkedLiteral(table: string, column: string): Promise<string | null> {
  const rows = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
  `.execute(app);
  for (const { def } of rows.rows) {
    if (!new RegExp(`\\b${column}\\b`).test(def)) continue;
    const literal = /'([^']*)'::/.exec(def) ?? /'([^']*)'/.exec(def);
    if (literal?.[1] !== undefined) return literal[1];
  }
  return null;
}

/** Table referenced by a single-column foreign key on the column, if any. */
async function referencedTable(table: string, column: string): Promise<string | null> {
  const rows = await sql<{ target: string }>`
    SELECT ft.relname AS target
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'f'
      AND array_length(c.conkey, 1) = 1 AND a.attname = ${column}
  `.execute(app);
  return rows.rows[0]?.target ?? null;
}

async function filler(table: string, column: Column): Promise<unknown> {
  if ((await referencedTable(table, column.name)) === 'users') return newUser();
  const literal = await checkedLiteral(table, column.name);
  if (literal !== null) return literal;
  switch (column.type) {
    case 'uuid':
      return randomUUID();
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return 0;
    case 'bool':
      return false;
    case 'timestamptz':
    case 'timestamp':
      return new Date('2026-10-01T00:00:00Z');
    case 'date':
      return '2026-10-01';
    case 'jsonb':
    case 'json':
      return '{}';
    case 'bytea':
      return Buffer.from(unique('b'));
    case 'inet':
      return '192.0.2.1';
    default:
      return unique('v');
  }
}

/** Inserts one row: the given values plus a value for every NOT NULL column without default. */
async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { ...values };
  for (const column of await columns(table)) {
    if (column.name in row || column.nullable || column.hasDefault) continue;
    row[column.name] = await filler(table, column);
  }
  const names = Object.keys(row);
  await sql`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))})
  `.execute(app);
  return row;
}

async function newUser(values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insertRow('users', { id, app_id: 'couli', ...values });
  return id;
}

// ---------------------------------------------------------------------------------------------
// devices (04 §3.2 devices; BR-ID-09 细则「设备标识的无效值」)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-02a#1] devices keep id_source within idfv / android_id / oaid / odid', async () => {
  for (const source of ['idfv', 'android_id', 'oaid', 'odid']) {
    expect(
      await sqlState(
        insertRow('devices', { app_id: 'couli', device_hash: hex64(), id_source: source }),
      ),
      source,
    ).toBe('no error');
  }
  for (const source of ['imei', 'IDFV', 'mac', '']) {
    expect(
      await sqlState(
        insertRow('devices', { app_id: 'couli', device_hash: hex64(), id_source: source }),
      ),
      JSON.stringify(source),
    ).toBe(CHECK_VIOLATION);
  }
});

it('[AC-B1-02a#2] devices.device_hash is 64 lowercase hex characters', async () => {
  for (const bad of [hex64().toUpperCase(), hex64().slice(0, 63), `${hex64().slice(0, 63)}g`, '']) {
    expect(
      await sqlState(
        insertRow('devices', { app_id: 'couli', device_hash: bad, id_source: 'idfv' }),
      ),
      bad,
    ).toBe(CHECK_VIOLATION);
  }
});

it('[AC-B1-02a#3] devices.last_login_sid is empty until a login writes it', async () => {
  const row = await insertRow('devices', {
    app_id: 'couli',
    device_hash: hex64(),
    id_source: 'odid',
  });
  const stored = await sql<{ last_login_sid: unknown }>`
    SELECT last_login_sid FROM app.devices WHERE device_hash = ${row['device_hash']}
  `.execute(app);
  expect(stored.rows).toEqual([{ last_login_sid: null }]);
  expect((await columns('devices')).find((c) => c.name === 'last_login_sid')?.nullable).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// users (04 §3.2 users; BR-INV-05; BR-ID-06; BR-ID-27)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-02a#4] a phone_hmac belongs to one account that is not finally deleted', async () => {
  const hmac = unique('hmac-');
  await newUser({ phone_hmac: hmac, status: 'deleting' });
  // Still in deletion (cooling or processing): the number stays taken (BR-INV-05).
  expect(await sqlState(newUser({ phone_hmac: hmac, status: 'deleting' }))).toBe(UNIQUE_VIOLATION);
  // Finally deleted accounts and merge tombstones no longer hold the number.
  expect(await sqlState(newUser({ phone_hmac: hmac, status: 'deleted' }))).toBe('no error');
  expect(
    await sqlState(newUser({ phone_hmac: hmac, status: 'deleted', deleted_reason: 'merged' })),
  ).toBe('no error');
});

it('[AC-B1-02a#5] the same phone_hmac in another app is a different account', async () => {
  const hmac = unique('hmac-');
  await newUser({ phone_hmac: hmac, status: 'deleting' });
  expect(
    await sqlState(newUser({ app_id: 'couli_two', phone_hmac: hmac, status: 'deleting' })),
  ).toBe('no error');
});

it('[AC-B1-02a#6] users.status accepts deleting and deleted, deleted_reason accepts merged', async () => {
  expect(await sqlState(newUser({ status: 'deleting' }))).toBe('no error');
  expect(await sqlState(newUser({ status: 'deleted', deleted_reason: 'merged' }))).toBe('no error');
});

// ---------------------------------------------------------------------------------------------
// user_oauth (04 §3.2 user_oauth; BR-ID-06, 功能对照 G-77)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-02a#7] one third-party identity belongs to one account', async () => {
  const unionId = unique('union-');
  const first = await newUser();
  const second = await newUser();
  await insertRow('user_oauth', {
    app_id: 'couli',
    user_id: first,
    provider: 'wechat',
    union_id: unionId,
  });
  expect(
    await sqlState(
      insertRow('user_oauth', {
        app_id: 'couli',
        user_id: second,
        provider: 'wechat',
        union_id: unionId,
      }),
    ),
  ).toBe(UNIQUE_VIOLATION);
  // The same union_id string from another provider is another identity.
  expect(
    await sqlState(
      insertRow('user_oauth', {
        app_id: 'couli',
        user_id: second,
        provider: 'apple',
        union_id: unionId,
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-02a#8] an account binds at most one identity per provider', async () => {
  const user = await newUser();
  await insertRow('user_oauth', {
    app_id: 'couli',
    user_id: user,
    provider: 'huawei',
    union_id: unique('union-'),
  });
  expect(
    await sqlState(
      insertRow('user_oauth', {
        app_id: 'couli',
        user_id: user,
        provider: 'huawei',
        union_id: unique('union-'),
      }),
    ),
  ).toBe(UNIQUE_VIOLATION);
  expect(
    await sqlState(
      insertRow('user_oauth', {
        app_id: 'couli',
        user_id: user,
        provider: 'wechat',
        union_id: unique('union-'),
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-02a#9] user_oauth.provider is wechat, apple or huawei', async () => {
  for (const provider of ['qq', 'WECHAT', 'phone', '']) {
    expect(
      await sqlState(
        insertRow('user_oauth', {
          app_id: 'couli',
          user_id: await newUser(),
          provider,
          union_id: unique('union-'),
        }),
      ),
      JSON.stringify(provider),
    ).toBe(CHECK_VIOLATION);
  }
});

it('[AC-B1-02a#10] merging moves the identity and violates the per-provider key when the target has one', async () => {
  const source = await newUser();
  const target = await newUser();
  await insertRow('user_oauth', {
    app_id: 'couli',
    user_id: target,
    provider: 'wechat',
    union_id: unique('union-'),
  });
  const moving = unique('union-');
  await insertRow('user_oauth', {
    app_id: 'couli',
    user_id: source,
    provider: 'wechat',
    union_id: moving,
  });
  // The phone account already has a WeChat identity: the move fails (30411 at the API).
  expect(
    await sqlState(
      sql`UPDATE app.user_oauth SET user_id = ${target}, merged_from_user_id = ${source}
          WHERE union_id = ${moving}`.execute(app),
    ),
  ).toBe(UNIQUE_VIOLATION);
  const free = await newUser();
  expect(
    await sqlState(
      sql`UPDATE app.user_oauth SET user_id = ${free}, merged_from_user_id = ${source}
          WHERE union_id = ${moving}`.execute(app),
    ),
  ).toBe('no error');
});

// ---------------------------------------------------------------------------------------------
// login_logs (04 §3.2 login_logs; BR-ID-37 细则)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-02a#11] login_logs accept method merge and are insert-only', async () => {
  const user = await newUser();
  const ip = '192.0.2.10';
  expect(
    await sqlState(
      insertRow('login_logs', {
        app_id: 'couli',
        user_id: user,
        device_id_hash: hex64(),
        ip,
        method: 'merge',
      }),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.login_logs SET method = 'merge' WHERE user_id = ${user}`.execute(app),
    ),
  ).not.toBe('no error');
  expect(
    await sqlState(sql`DELETE FROM app.login_logs WHERE user_id = ${user}`.execute(app)),
  ).not.toBe('no error');
  const left = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.login_logs WHERE user_id = ${user}
  `.execute(app);
  expect(left.rows).toEqual([{ n: '1' }]);
});

// ---------------------------------------------------------------------------------------------
// device_registrations (04 §3.2 device_registrations; BR-ID-05 细则「同设备注册上限的计数」)
// ---------------------------------------------------------------------------------------------

async function newRegistration(user: string, deviceHash = hex64()): Promise<void> {
  await insertRow('device_registrations', {
    app_id: 'couli',
    device_hash: deviceHash,
    user_id: user,
  });
}

it('[AC-B1-02a#12] an account has at most one registration record', async () => {
  const user = await newUser();
  await newRegistration(user);
  expect(await sqlState(newRegistration(user))).toBe(UNIQUE_VIOLATION);
  const stored = await sql<{ merged_into_user_id: unknown }>`
    SELECT merged_into_user_id FROM app.device_registrations WHERE user_id = ${user}
  `.execute(app);
  expect(stored.rows).toEqual([{ merged_into_user_id: null }]);
});

it('[AC-B1-02a#13] registration records are indexed by (app_id, device_hash, created_at)', async () => {
  const rows = await sql<{ def: string }>`
    SELECT indexdef AS def FROM pg_indexes
    WHERE schemaname = 'app' AND tablename = 'device_registrations'
  `.execute(app);
  expect(
    rows.rows.some(({ def }) => /\(\s*app_id\s*,\s*device_hash\s*,\s*created_at\b/.test(def)),
    JSON.stringify(rows.rows),
  ).toBe(true);
});

it('[AC-B1-02a#14] registration records are never deleted', async () => {
  const user = await newUser();
  await newRegistration(user);
  expect(
    await sqlState(sql`DELETE FROM app.device_registrations WHERE user_id = ${user}`.execute(app)),
  ).not.toBe('no error');
  const left = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.device_registrations WHERE user_id = ${user}
  `.execute(app);
  expect(left.rows).toEqual([{ n: '1' }]);
});

it('[AC-B1-02a#15] only merged_into_user_id may change, once, from empty to an account', async () => {
  const source = await newUser();
  const target = await newUser();
  const other = await newUser();
  const deviceHash = hex64();
  await newRegistration(source, deviceHash);
  // Any other column is never rewritten.
  expect(
    await sqlState(
      sql`UPDATE app.device_registrations SET device_hash = ${hex64()} WHERE user_id = ${source}`.execute(
        app,
      ),
    ),
  ).not.toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.device_registrations SET user_id = ${other} WHERE user_id = ${source}`.execute(
        app,
      ),
    ),
  ).not.toBe('no error');
  // The merge writes the target once.
  expect(
    await sqlState(
      sql`UPDATE app.device_registrations SET merged_into_user_id = ${target}
          WHERE user_id = ${source}`.execute(app),
    ),
  ).toBe('no error');
  // It is not rewritten to another account, nor cleared.
  expect(
    await sqlState(
      sql`UPDATE app.device_registrations SET merged_into_user_id = ${other}
          WHERE user_id = ${source}`.execute(app),
    ),
  ).not.toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.device_registrations SET merged_into_user_id = NULL
          WHERE user_id = ${source}`.execute(app),
    ),
  ).not.toBe('no error');
  const stored = await sql<{ device_hash: string; merged_into_user_id: string }>`
    SELECT device_hash, merged_into_user_id FROM app.device_registrations WHERE user_id = ${source}
  `.execute(app);
  expect(stored.rows).toEqual([{ device_hash: deviceHash, merged_into_user_id: target }]);
});

it('[AC-B1-02a#16] every identity table carries app_id NOT NULL', async () => {
  for (const table of ['devices', 'users', 'user_oauth', 'login_logs', 'device_registrations']) {
    const appId = (await columns(table)).find((c) => c.name === 'app_id');
    expect(appId, table).toBeDefined();
    expect(appId?.nullable, table).toBe(false);
  }
});

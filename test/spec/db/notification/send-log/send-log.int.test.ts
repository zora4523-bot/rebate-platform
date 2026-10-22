// B1-12e: 04 §3.2 notify_templates / notify_logs and task supplement B (technical decisions).
// No sending, preferences, retention or other BR behavior is implemented by this migration.
// Only the existing globalSetup reads the admin database URL; workers use business-role URLs.
// Catalog assertions precede DML so an absent table produces an assertion failure in red runs.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { foreignKeys, hasPrivilege, newUser, sqlState, useDb } from '../kit.ts';

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
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  if (database) await database.drop();
});

const TABLES = ['notify_templates', 'notify_logs'] as const;
type Table = (typeof TABLES)[number];
const PLANNED = new Date('2026-10-18T08:00:00Z');
const SENT = new Date('2026-10-18T09:00:00Z');
let sequence = 0;

function template(values: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    app_id: 'couli',
    code: `NOTICE_${String(sequence)}`,
    category: 'service',
    channels: ['inbox'],
    ...values,
  };
}

function log(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    app_id: 'couli',
    user_id: null,
    code: 'UNION_AUTH_EXPIRING',
    channel: 'sms',
    dedupe_key: `notice-${randomUUID()}`,
    planned_at: PLANNED,
    ...values,
  };
}

async function requireTable(table: Table): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'app' AND t.relname = ${table} AND t.relkind IN ('r', 'p')
    ) AS present
  `.execute(app);
  expect(result.rows, `app.${table} exists before exercising its constraints`).toEqual([
    { present: true },
  ]);
}

// No catalog-derived fillers: missing required columns/defaults must fail this task's inserts.
async function insert(
  table: Table,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function columns(table: string) {
  const result = await sql<{
    name: string;
    type: string;
    nullable: boolean;
    default_value: string | null;
  }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
           column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY column_name
  `.execute(app);
  return result.rows;
}

async function primaryKey(table: Table): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT a.attname AS name FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'p'
    ORDER BY k.ord
  `.execute(app);
  return result.rows.map((row) => row.name);
}

async function mayDo(role: string, table: Table, privilege: string): Promise<boolean> {
  if (await hasPrivilege(role, table, privilege)) return true;
  if (privilege === 'DELETE' || privilege === 'TRUNCATE') return false;
  const result = await sql<{ ok: boolean }>`
    SELECT has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege}) AS ok
  `.execute(app);
  return result.rows[0]?.ok === true;
}

it('[AC-B1-12e#1] templates have exactly the agreed columns; inbox_messages keeps its columns', async () => {
  await requireTable('notify_templates');
  const shape = (await columns('notify_templates')).map(({ name, type, nullable }) => [
    name,
    type,
    nullable,
  ]);
  // B1-12f：新增变体与覆盖列
  expect(shape).toEqual([
    ['app_id', 'text', false],
    ['body_override', 'text', true],
    ['category', 'text', false],
    ['channels', '_text', false],
    ['code', 'text', false],
    ['created_at', 'timestamptz', false],
    ['route', 'jsonb', true],
    ['row_version', 'int4', false],
    ['title_override', 'text', true],
    ['updated_at', 'timestamptz', false],
    ['variant', 'text', false],
  ]);
  expect((await columns('inbox_messages')).map((row) => row.name)).toEqual([
    'app_id',
    'body',
    'code',
    'created_at',
    'message_id',
    'read_at',
    'route',
    'row_version',
    'title',
    'updated_at',
    'user_id',
  ]);
});

it('[AC-B1-12e#2] logs have the agreed types and optional user_id/sent_at; IDs and send moments have no SQL defaults', async () => {
  await requireTable('notify_logs');
  const metadata = await columns('notify_logs');
  expect(metadata.map(({ name, type, nullable }) => [name, type, nullable])).toEqual([
    ['app_id', 'text', false],
    ['channel', 'text', false],
    ['code', 'text', false],
    ['created_at', 'timestamptz', false],
    ['dedupe_key', 'text', false],
    ['id', 'uuid', false],
    ['planned_at', 'timestamptz', false],
    ['row_version', 'int4', false],
    ['sent_at', 'timestamptz', true],
    ['status', 'text', false],
    ['suppress_reason', 'text', true],
    ['updated_at', 'timestamptz', false],
    ['user_id', 'uuid', true],
  ]);
  for (const name of ['id', 'planned_at', 'sent_at']) {
    expect(metadata.find((row) => row.name === name)?.default_value, name).toBeNull();
  }
});

it('[AC-B1-12e#3] defaults are version zero, queued and transaction timestamps; application time is preserved', async () => {
  for (const table of TABLES) {
    await requireTable(table);
    const metadata = await columns(table);
    expect(metadata.find((row) => row.name === 'row_version')?.default_value).toBe('0');
    if (table === 'notify_logs') {
      expect(metadata.find((row) => row.name === 'status')?.default_value).toBe("'queued'::text");
    }
    for (const name of ['created_at', 'updated_at']) {
      const col = metadata.find((row) => row.name === name);
      expect(col?.default_value, `${table}.${name}`).toMatch(/^(now\(\)|CURRENT_TIMESTAMP)$/i);
    }
    await app.transaction().execute(async (tx) => {
      const row = table === 'notify_templates' ? template() : log();
      const names = Object.keys(row);
      const result = await sql<{ version: number; created: boolean; updated: boolean }>`
        INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((name) => sql.ref(name)))})
        VALUES (${sql.join(names.map((name) => row[name]))})
        RETURNING row_version AS version, created_at = now() AS created, updated_at = now() AS updated
      `.execute(tx);
      expect(result.rows).toEqual([{ version: 0, created: true, updated: true }]);
    });
  }
  const row = await insert('notify_logs', log());
  expect(row['status']).toBe('queued');
  expect(row['sent_at']).toBeNull();
  expect(row['user_id']).toBeNull();
  expect(row['planned_at']).toEqual(PLANNED);
  const later = await sql`UPDATE app.notify_logs SET planned_at = ${SENT}, row_version = 1
    WHERE id = ${row['id']} AND row_version = 0`.execute(app);
  expect(later.numAffectedRows).toBe(1n);
  const stale = await sql`UPDATE app.notify_logs SET planned_at = ${PLANNED}, row_version = 2
    WHERE id = ${row['id']} AND row_version = 0`.execute(app);
  expect(stale.numAffectedRows).toBe(0n);
  const notice = await insert('notify_templates', template());
  expect(notice['route']).toBeNull();
  const changed = await sql`UPDATE app.notify_templates
    SET category = 'subscription', channels = ARRAY['inbox', 'push'], row_version = 1,
        route = '{"route":"order_detail","params":{}}'::jsonb, updated_at = ${SENT}
    WHERE app_id = ${notice['app_id']} AND code = ${notice['code']} AND row_version = 0
    RETURNING category, channels, row_version, updated_at`.execute(app);
  expect(changed.rows).toEqual([
    {
      category: 'subscription',
      channels: ['inbox', 'push'],
      row_version: 1,
      updated_at: SENT,
    },
  ]);
});

it('[AC-B1-12e#4] template primary key is (app_id, code), allowing the same code in another app', async () => {
  await requireTable('notify_templates');
  // B1-12f：新增变体与覆盖列
  expect(await primaryKey('notify_templates')).toEqual(['app_id', 'code', 'variant']);
  const row = template();
  await insert('notify_templates', row);
  expect(await sqlState(insert('notify_templates', row))).toBe('23505');
  expect(await sqlState(insert('notify_templates', { ...row, app_id: 'couli_two' }))).toBe(
    'no error',
  );
});

it('[AC-B1-12e#5] template code is uppercase snake case on insert and update', async () => {
  await requireTable('notify_templates');
  for (const code of ['ORDER_CREDITED', 'UNION_AUTH_EXPIRING', 'ALERT_2']) {
    expect(await sqlState(insert('notify_templates', template({ code })))).toBe('no error');
  }
  for (const code of ['', 'order_credited', 'Order_CREDITED', 'ORDER-CREDITED', 'ORDER CREDITED']) {
    expect(await sqlState(insert('notify_templates', template({ code }))), code).toBe('23514');
  }
  const row = await insert('notify_templates', template());
  expect(
    await sqlState(
      sql`UPDATE app.notify_templates SET code = 'bad-code'
      WHERE app_id = ${row['app_id']} AND code = ${row['code']}`.execute(app),
    ),
  ).toBe('23514');
});

it('[AC-B1-12e#6] template categories are service, subscription or marketing', async () => {
  await requireTable('notify_templates');
  for (const category of ['service', 'subscription', 'marketing']) {
    expect(await sqlState(insert('notify_templates', template({ category })))).toBe('no error');
  }
  for (const category of ['', 'SERVICE', 'transactional', 'other']) {
    expect(await sqlState(insert('notify_templates', template({ category }))), category).toBe(
      '23514',
    );
  }
});

it('[AC-B1-12e#7] channels is a nonempty text array of inbox, push and sms, with no null elements', async () => {
  await requireTable('notify_templates');
  for (const channels of [['inbox'], ['push'], ['sms'], ['inbox', 'push', 'sms']]) {
    const row = await insert('notify_templates', template({ channels }));
    expect(row['channels']).toEqual(channels);
  }
  for (const channels of [
    [],
    ['email'],
    ['PUSH'],
    [''],
    ['inbox', 'email'],
    [null],
    ['sms', null],
  ]) {
    expect(
      await sqlState(insert('notify_templates', template({ channels }))),
      JSON.stringify(channels),
    ).toBe('23514');
  }
});

it('[AC-B1-12e#8] route accepts SQL NULL and JSON objects, rejecting JSON null, scalars and arrays', async () => {
  await requireTable('notify_templates');
  const route = { route: 'order_detail', params: { order_id: 'order-fixture' } };
  expect(
    (await insert('notify_templates', template({ route: JSON.stringify(route) })))['route'],
  ).toEqual(route);
  expect((await insert('notify_templates', template({ route: null })))['route']).toBeNull();
  expect((await insert('notify_templates', template({ route: '{}' })))['route']).toEqual({});
  for (const value of ['null', '[]', '[{}]', '"order_detail"', '3', 'true']) {
    expect(await sqlState(insert('notify_templates', template({ route: value }))), value).toBe(
      '23514',
    );
  }
});

it('[AC-B1-12e#9] log channels and statuses are closed text sets', async () => {
  await requireTable('notify_logs');
  for (const channel of ['inbox', 'push', 'sms']) {
    for (const status of ['queued', 'success', 'failed']) {
      expect(
        await sqlState(
          insert(
            'notify_logs',
            log({ channel, status, sent_at: status === 'success' ? SENT : null }),
          ),
        ),
      ).toBe('no error');
    }
  }
  for (const channel of ['', 'email', 'PUSH']) {
    expect(await sqlState(insert('notify_logs', log({ channel })))).toBe('23514');
  }
  for (const status of ['', 'pending', 'sent', 'SUCCESS']) {
    expect(await sqlState(insert('notify_logs', log({ status })))).toBe('23514');
  }
});

it('[AC-B1-12e#10] required fields reject SQL NULL; dedupe_key also rejects the empty string', async () => {
  for (const table of TABLES) {
    await requireTable(table);
    const required =
      table === 'notify_templates'
        ? ['app_id', 'code', 'category', 'channels', 'row_version', 'created_at', 'updated_at']
        : [
            'id',
            'app_id',
            'code',
            'channel',
            'dedupe_key',
            'planned_at',
            'status',
            'row_version',
            'created_at',
            'updated_at',
          ];
    for (const name of required) {
      const values = { [name]: null };
      expect(
        await sqlState(
          insert(table, table === 'notify_templates' ? template(values) : log(values)),
        ),
        `${table}.${name}`,
      ).toBe('23502');
    }
  }
  expect(await sqlState(insert('notify_logs', log({ dedupe_key: '' })))).toBe('23514');
});

it('[AC-B1-12e#11] success requires sent_at and queued forbids it, including UPDATE; failed permits either', async () => {
  await requireTable('notify_logs');
  expect(await sqlState(insert('notify_logs', log({ status: 'success', sent_at: null })))).toBe(
    '23514',
  );
  expect(await sqlState(insert('notify_logs', log({ status: 'queued', sent_at: SENT })))).toBe(
    '23514',
  );
  for (const sent_at of [null, SENT]) {
    expect(await sqlState(insert('notify_logs', log({ status: 'failed', sent_at })))).toBe(
      'no error',
    );
  }
  const row = await insert('notify_logs', log());
  expect(
    await sqlState(
      sql`UPDATE app.notify_logs SET status = 'success'
      WHERE id = ${row['id']}`.execute(app),
    ),
  ).toBe('23514');
  expect(
    await sqlState(
      sql`UPDATE app.notify_logs SET sent_at = ${SENT}
      WHERE id = ${row['id']}`.execute(app),
    ),
  ).toBe('23514');
  const sent = await sql`UPDATE app.notify_logs SET status = 'success', sent_at = ${SENT},
    row_version = row_version + 1 WHERE id = ${row['id']} AND row_version = 0`.execute(app);
  expect(sent.numAffectedRows).toBe(1n);
  expect(
    await sqlState(
      sql`UPDATE app.notify_logs SET sent_at = NULL
      WHERE id = ${row['id']}`.execute(app),
    ),
  ).toBe('23514');
  expect(
    await sqlState(
      sql`UPDATE app.notify_logs SET status = 'queued'
      WHERE id = ${row['id']}`.execute(app),
    ),
  ).toBe('23514');
});

it('[AC-B1-12e#12] optional users reference users(app_id, id), reject cross-app and missing users, and never cascade', async () => {
  await requireTable('notify_logs');
  const keys = await foreignKeys('notify_logs');
  expect(keys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        columns: ['app_id', 'user_id'],
        target: 'users',
        targetColumns: ['app_id', 'id'],
      }),
    ]),
  );
  for (const table of TABLES) {
    await requireTable(table);
    for (const key of await foreignKeys(table)) {
      expect(['a', 'r'], `${table}.${key.name} ON DELETE`).toContain(key.onDelete);
      expect(['a', 'r'], `${table}.${key.name} ON UPDATE`).toContain(key.onUpdate);
    }
  }
  const user = await newUser('couli');
  expect(await sqlState(insert('notify_logs', log({ user_id: user })))).toBe('no error');
  expect(await sqlState(insert('notify_logs', log({ user_id: null })))).toBe('no error');
  expect(await sqlState(insert('notify_logs', log({ user_id: user, app_id: 'couli_two' })))).toBe(
    '23503',
  );
  expect(await sqlState(insert('notify_logs', log({ user_id: randomUUID() })))).toBe('23503');
});

it('[AC-B1-12e#13] (app_id, dedupe_key) is unique across users, channels, codes and terminal statuses', async () => {
  await requireTable('notify_logs');
  const user = await newUser();
  for (const status of ['queued', 'success', 'failed']) {
    const key = `dedupe-${randomUUID()}`;
    await insert(
      'notify_logs',
      log({ dedupe_key: key, status, sent_at: status === 'success' ? SENT : null }),
    );
    expect(
      await sqlState(
        insert(
          'notify_logs',
          log({
            dedupe_key: key,
            channel: 'push',
            code: 'OTHER_NOTICE',
            user_id: user,
            planned_at: SENT,
          }),
        ),
      ),
    ).toBe('23505');
    expect(
      await sqlState(insert('notify_logs', log({ dedupe_key: key, app_id: 'couli_two' }))),
    ).toBe('no error');
    const other = await insert('notify_logs', log());
    expect(
      await sqlState(
        sql`UPDATE app.notify_logs SET dedupe_key = ${key}
        WHERE id = ${other['id']}`.execute(app),
      ),
    ).toBe('23505');
  }
});

it('[AC-B1-12e#14] concurrent deliveries with the same app/key persist exactly one log', async () => {
  await requireTable('notify_logs');
  const key = `concurrent-${randomUUID()}`;
  const outcomes = await Promise.all([
    sqlState(insert('notify_logs', log({ dedupe_key: key }))),
    sqlState(insert('notify_logs', log({ dedupe_key: key }))),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const stored = await sql<{ count: number }>`SELECT count(*)::integer AS count
    FROM app.notify_logs WHERE app_id = 'couli' AND dedupe_key = ${key}`.execute(app);
  expect(stored.rows).toEqual([{ count: 1 }]);
});

it('[AC-B1-12e#15] logs use id as the primary key, independent of app_id', async () => {
  await requireTable('notify_logs');
  expect(await primaryKey('notify_logs')).toEqual(['id']);
  const row = await insert('notify_logs', log());
  expect(await sqlState(insert('notify_logs', log({ id: row['id'], app_id: 'couli_two' })))).toBe(
    '23505',
  );
});

it('[AC-B1-12e#16] system log codes do not require a template row', async () => {
  for (const table of TABLES) await requireTable(table);
  const keys = await foreignKeys('notify_logs');
  expect(
    keys.filter((key) => key.columns.includes('code') || key.target === 'notify_templates'),
  ).toEqual([]);
  const absent = await sql<{ count: number }>`SELECT count(*)::integer AS count
    FROM app.notify_templates WHERE code = 'SYSTEM_ALERT_WITHOUT_TEMPLATE'`.execute(app);
  expect(absent.rows).toEqual([{ count: 0 }]);
  expect(
    await sqlState(
      insert('notify_logs', log({ code: 'SYSTEM_ALERT_WITHOUT_TEMPLATE', user_id: null })),
    ),
  ).toBe('no error');
});

it('[AC-B1-12e#17] due and user-created scan indexes exist on the agreed column sequences', async () => {
  await requireTable('notify_logs');
  const result = await sql<{ name: string; columns: string[]; valid: boolean }>`
    SELECT i.relname AS name, x.indisvalid AND x.indisready AS valid,
      ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE k.ord <= x.indnkeyatts ORDER BY k.ord) AS columns
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class i ON i.oid = x.indexrelid
    WHERE n.nspname = 'app' AND t.relname = 'notify_logs'
  `.execute(app);
  expect(result.rows).toEqual(
    expect.arrayContaining([
      { name: 'notify_logs_due_idx', columns: ['status', 'planned_at'], valid: true },
      {
        name: 'notify_logs_user_created_idx',
        columns: ['app_id', 'user_id', 'created_at'],
        valid: true,
      },
    ]),
  );
});

it('[AC-B1-12e#18] app may select/insert/update but not delete/truncate; readonly reads, payout/maint have no access', async () => {
  for (const table of TABLES) {
    await requireTable(table);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      expect(await mayDo('couli_app', table, privilege), `${table} ${privilege}`).toBe(true);
    }
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      expect(await mayDo('couli_app', table, privilege), `${table} ${privilege}`).toBe(false);
    }
    expect(
      await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE false`.execute(app)),
    ).toBe('42501');
    expect(await hasPrivilege('couli_readonly', table, 'SELECT')).toBe(true);
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(readonly)),
    ).toBe('no error');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await mayDo('couli_readonly', table, privilege), `${table} ${privilege}`).toBe(false);
    }
    for (const role of ['couli_payout', 'couli_maint']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await mayDo(role, table, privilege), `${role} ${table} ${privilege}`).toBe(false);
      }
    }
  }
});

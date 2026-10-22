// B1-12f supplement B: variants and optional wording overrides; no default copy in the table.
// Inspect the catalog before DML so the pre-migration schema fails assertions, not SQL parsing.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { sqlState } from '../kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let sequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  if (database) await database.drop();
});

async function columns(table = 'notify_templates') {
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

async function requireOverrides(): Promise<void> {
  expect((await columns()).map((column) => column.name)).toEqual(
    expect.arrayContaining(['variant', 'title_override', 'body_override']),
  );
}

function template(values: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    app_id: 'couli',
    code: `OVERRIDE_${String(sequence)}`,
    category: 'service',
    channels: ['inbox'],
    ...values,
  };
}

async function insert(row: Record<string, unknown>, db = app): Promise<Record<string, unknown>> {
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO app.notify_templates (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function update(row: Record<string, unknown>, values: Record<string, unknown>, db = app) {
  return sql<Record<string, unknown>>`
    UPDATE app.notify_templates
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = ${row['variant']}
    RETURNING *
  `.execute(db);
}

it('[AC-B1-12f#1] template columns have the agreed types, nullability and defaults', async () => {
  const metadata = await columns();
  expect(metadata.map(({ name, type, nullable }) => [name, type, nullable])).toEqual([
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
  expect(metadata.find((column) => column.name === 'variant')?.default_value).toBe(
    "'default'::text",
  );
  expect(metadata.find((column) => column.name === 'row_version')?.default_value).toBe('0');
  for (const name of ['app_id', 'code', 'category', 'channels', 'route']) {
    expect(metadata.find((column) => column.name === name)?.default_value, name).toBeNull();
  }
  for (const name of ['created_at', 'updated_at']) {
    expect(metadata.find((column) => column.name === name)?.default_value, name).toMatch(
      /^(now\(\)|CURRENT_TIMESTAMP)$/i,
    );
  }
  const checked = await sql<{ name: string }>`
    SELECT DISTINCT a.attname AS name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'app' AND t.relname = 'notify_templates'
      AND c.contype = 'c' AND c.convalidated
  `.execute(app);
  expect(checked.rows.map((column) => column.name)).toEqual(
    expect.arrayContaining(['variant', 'title_override', 'body_override']),
  );
});

it('[AC-B1-12f#2] old-style inserts receive default variant, null overrides and unchanged defaults', async () => {
  await requireOverrides();
  const row = await insert(template());
  expect(row).toMatchObject({
    variant: 'default',
    title_override: null,
    body_override: null,
    route: null,
    row_version: 0,
  });
  await app.transaction().execute(async (tx) => {
    const saved = await insert(template(), tx);
    const result = await sql<{ created: boolean; updated: boolean }>`
      SELECT created_at = now() AS created, updated_at = now() AS updated
      FROM app.notify_templates WHERE app_id = ${saved['app_id']} AND code = ${saved['code']}
    `.execute(tx);
    expect(result.rows).toEqual([{ created: true, updated: true }]);
  });
  expect(await sqlState(insert(template({ variant: null })))).toBe('23502');
  expect(await sqlState(update(row, { variant: null }))).toBe('23502');
});

it('[AC-B1-12f#3] variant is an open lowercase snake-case identifier on insert and update', async () => {
  await requireOverrides();
  const row = await insert(template());
  for (const variant of [
    'default',
    'frozen',
    'frozen_until',
    'unfrozen',
    'banned',
    'unbanned',
    'a',
    'v2',
    'future_2_state',
  ]) {
    expect((await insert(template({ variant })))['variant'], variant).toBe(variant);
    const changed = await update(row, { variant });
    expect(changed.rows).toHaveLength(1);
    expect(changed.rows[0]?.['variant']).toBe(variant);
    row['variant'] = variant;
  }
  for (const variant of [
    '',
    ' ',
    'Frozen',
    'FROZEN',
    '2frozen',
    '_frozen',
    'frozen_',
    'frozen__until',
    'frozen-until',
    'frozen.until',
    'frozen until',
    ' frozen',
    'frozen ',
    'frozen\n',
    'frozen\t',
    '冻结',
  ]) {
    expect(await sqlState(insert(template({ variant }))), JSON.stringify(variant)).toBe('23514');
    expect(await sqlState(update(row, { variant })), JSON.stringify(variant)).toBe('23514');
  }
});

it('[AC-B1-12f#4] named primary key uses app_id, code and variant in that order', async () => {
  await requireOverrides();
  const keys = await sql<{ name: string; columns: string[] }>`
    SELECT c.conname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord) AS columns
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = 'notify_templates' AND c.contype = 'p'
  `.execute(app);
  expect(keys.rows).toEqual([
    { name: 'notify_templates_pkey', columns: ['app_id', 'code', 'variant'] },
  ]);
  const base = template();
  const first = await insert(base);
  expect(await sqlState(insert({ ...base, variant: 'default' }))).toBe('23505');
  const frozen = await insert({ ...base, variant: 'frozen' });
  expect(frozen['variant']).toBe('frozen');
  expect(await sqlState(insert({ ...base, variant: 'frozen' }))).toBe('23505');
  expect(await sqlState(update(frozen, { variant: 'default' }))).toBe('23505');
  expect((await insert({ ...base, variant: 'frozen', app_id: 'couli_two' }))['app_id']).toBe(
    'couli_two',
  );
  expect((await insert(template({ variant: first['variant'] })))['variant']).toBe('default');
});

it('[AC-B1-12f#5] simultaneous inserts of the same triple persist exactly one row', async () => {
  await requireOverrides();
  const row = template({ variant: 'frozen_until' });
  const outcomes = await Promise.all([sqlState(insert(row)), sqlState(insert(row))]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const count = await sql<{ count: number }>`
    SELECT count(*)::integer AS count FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = 'frozen_until'
  `.execute(app);
  expect(count.rows).toEqual([{ count: 1 }]);
});

it('[AC-B1-12f#6] each override independently accepts NULL or nonblank text without rewriting wording', async () => {
  await requireOverrides();
  for (const name of ['title_override', 'body_override']) {
    const other = name === 'title_override' ? 'body_override' : 'title_override';
    for (const value of [null, '提醒', '0', '  请查看通知  ', '\t提醒\n第二行\r\n']) {
      const row = await insert(template({ [name]: value, [other]: null }));
      expect(row[name]).toBe(value);
      expect(row[other]).toBeNull();
      const changed = await update(row, { [name]: '新措辞', [other]: '另一段措辞' });
      expect(changed.rows).toHaveLength(1);
      expect(changed.rows[0]).toMatchObject({ [name]: '新措辞', [other]: '另一段措辞' });
      const cleared = await update(row, { [name]: null });
      expect(cleared.rows).toHaveLength(1);
      expect(cleared.rows[0]).toMatchObject({ [name]: null, [other]: '另一段措辞' });
    }
  }
});

it('[AC-B1-12f#7] both override CHECKs reject empty or whitespace-only values on insert and update', async () => {
  await requireOverrides();
  const row = await insert(template({ title_override: '标题', body_override: '正文' }));
  for (const name of ['title_override', 'body_override']) {
    const other = name === 'title_override' ? 'body_override' : 'title_override';
    for (const value of ['', ' ', '   ', '\t', '\n', '\r', '\r\n', '\v', '\f', ' \t\r\n ']) {
      for (const otherValue of [null, '有效措辞']) {
        expect(
          await sqlState(insert(template({ [name]: value, [other]: otherValue }))),
          `${name} ${JSON.stringify(value)}`,
        ).toBe('23514');
        expect(
          await sqlState(update(row, { [name]: value, [other]: otherValue })),
          `${name} ${JSON.stringify(value)}`,
        ).toBe('23514');
      }
    }
  }
  const stored = await sql<{ title_override: string; body_override: string }>`
    SELECT title_override, body_override FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = 'default'
  `.execute(app);
  expect(stored.rows).toEqual([{ title_override: '标题', body_override: '正文' }]);
});

it('[AC-B1-12f#8] editing one variant leaves the other variant and app wording intact', async () => {
  await requireOverrides();
  const base = template({ title_override: '原标题', body_override: '原正文' });
  const first = await insert({ ...base, variant: 'frozen' });
  await insert({ ...base, variant: 'unfrozen' });
  await insert({ ...base, variant: 'frozen', app_id: 'couli_two' });
  const changed = await update(first, { title_override: '已冻结', body_override: null });
  expect(changed.rows).toHaveLength(1);
  const stored = await sql<{
    app_id: string;
    variant: string;
    title_override: string;
    body_override: string | null;
  }>`
    SELECT app_id, variant, title_override, body_override FROM app.notify_templates
    WHERE code = ${base['code']} ORDER BY app_id, variant
  `.execute(app);
  expect(stored.rows).toEqual([
    { app_id: 'couli', variant: 'frozen', title_override: '已冻结', body_override: null },
    { app_id: 'couli', variant: 'unfrozen', title_override: '原标题', body_override: '原正文' },
    { app_id: 'couli_two', variant: 'frozen', title_override: '原标题', body_override: '原正文' },
  ]);
});

it('[AC-B1-12f#9] existing template CHECKs and required fields still apply to every variant', async () => {
  await requireOverrides();
  const row = await insert(template({ variant: 'frozen' }));
  for (const category of ['service', 'subscription', 'marketing']) {
    for (const channels of [['inbox'], ['push'], ['sms'], ['inbox', 'push', 'sms']]) {
      const saved = await insert(
        template({ category, channels, variant: 'unbanned', route: '{}' }),
      );
      expect(saved).toMatchObject({ category, channels, route: {} });
    }
  }
  const invalid = [
    ...['', 'bad_code', 'Bad_CODE', '_CODE', 'CODE_', 'CODE__X', 'CODE-X'].map((code) => ({
      code,
    })),
    ...['', 'SERVICE', 'transactional', 'other'].map((category) => ({ category })),
    ...[[], ['email'], ['PUSH'], [''], ['inbox', 'email'], [null], ['sms', null]].map(
      (channels) => ({ channels }),
    ),
    ...['null', '[]', '[{}]', '"detail"', '3', 'true'].map((route) => ({ route })),
  ];
  for (const values of invalid) {
    expect(
      await sqlState(insert(template({ variant: 'frozen', ...values }))),
      JSON.stringify(values),
    ).toBe('23514');
    expect(await sqlState(update(row, values)), JSON.stringify(values)).toBe('23514');
  }
  for (const name of [
    'app_id',
    'code',
    'category',
    'channels',
    'row_version',
    'created_at',
    'updated_at',
  ]) {
    expect(await sqlState(insert(template({ [name]: null }))), name).toBe('23502');
    expect(await sqlState(update(row, { [name]: null })), name).toBe('23502');
  }
  const time = new Date('2026-10-18T09:00:00Z');
  const changed = await update(row, {
    category: 'subscription',
    channels: ['push'],
    route: '{"route":"order_detail","params":{}}',
    row_version: 1,
    updated_at: time,
  });
  expect(changed.rows).toHaveLength(1);
  expect(changed.rows[0]).toMatchObject({
    category: 'subscription',
    channels: ['push'],
    route: { route: 'order_detail', params: {} },
    row_version: 1,
    updated_at: time,
  });
});

it('[AC-B1-12f#10] table-level app grants and readonly restrictions cover the new columns', async () => {
  await requireOverrides();
  for (const role of ['couli_app', 'couli_readonly']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const granted = await sql<{ table_ok: boolean }>`
        SELECT has_table_privilege(${role}, 'app.notify_templates', ${privilege}) AS table_ok
      `.execute(app);
      const allowed =
        role === 'couli_app'
          ? ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
          : privilege === 'SELECT';
      expect(granted.rows, `${role} ${privilege}`).toEqual([{ table_ok: allowed }]);
      if (['INSERT', 'UPDATE'].includes(privilege) && role === 'couli_readonly') {
        const columnGrant = await sql<{ ok: boolean }>`
          SELECT has_any_column_privilege(${role}, 'app.notify_templates', ${privilege}) AS ok
        `.execute(app);
        expect(columnGrant.rows).toEqual([{ ok: false }]);
      }
    }
  }
  const row = await insert(
    template({ variant: 'frozen', title_override: '标题', body_override: '正文' }),
  );
  expect((await update(row, { title_override: '新标题' })).rows).toHaveLength(1);
  const read = await sql<{ variant: string; title_override: string; body_override: string }>`
    SELECT variant, title_override, body_override FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']}
  `.execute(readonly);
  expect(read.rows).toEqual([
    { variant: 'frozen', title_override: '新标题', body_override: '正文' },
  ]);
  expect(await sqlState(insert(template(), readonly))).toBe('42501');
  expect(await sqlState(update(row, { title_override: '不允许' }, readonly))).toBe('42501');
  for (const db of [app, readonly]) {
    expect(await sqlState(sql`DELETE FROM app.notify_templates WHERE false`.execute(db))).toBe(
      '42501',
    );
  }
});

it('[AC-B1-12f#11] notify_logs and inbox_messages retain their existing column sets', async () => {
  await requireOverrides();
  expect((await columns('notify_logs')).map((column) => column.name)).toEqual([
    'app_id',
    'channel',
    'code',
    'created_at',
    'dedupe_key',
    'id',
    'planned_at',
    'row_version',
    'sent_at',
    'status',
    'suppress_reason',
    'updated_at',
    'user_id',
  ]);
  expect((await columns('inbox_messages')).map((column) => column.name)).toEqual([
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

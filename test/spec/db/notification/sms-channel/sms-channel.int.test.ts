// B1-12x: 08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」and task supplement B (D10-316 ①).
// notify_templates registers one SMS channel per code × variant (sign name, Aliyun template CODE,
// template type verify / notice, preview text: all NULL or all set); notify_logs keeps the Aliyun
// receipt id (BizId) of SMS rows. Storage only: the switch stays in channels, no credential column.
// Check the new columns in the catalog before DML: the unmigrated database must fail assertions.
import { randomUUID } from 'node:crypto';

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

const SMS_COLUMNS = [
  'sms_sign_name',
  'sms_template_code',
  'sms_template_type',
  'sms_preview_text',
] as const;
const NEW_COLUMNS = [
  { table: 'notify_templates', names: SMS_COLUMNS },
  { table: 'notify_logs', names: ['sms_biz_id'] },
] as const;
const REGISTERED = {
  sms_sign_name: '凑狸',
  sms_template_code: 'SMS_154950909',
  sms_template_type: 'notice',
  sms_preview_text: '【凑狸】提现未成功，请到钱包查看原因。',
};
const UNREGISTERED = {
  sms_sign_name: null,
  sms_template_code: null,
  sms_template_type: null,
  sms_preview_text: null,
};
/** Every subset of the registration columns (the ones set; the others are NULL). */
const SUBSETS = SMS_COLUMNS.reduce<string[][]>(
  (subsets, name) => [...subsets, ...subsets.map((subset) => [...subset, name])],
  [[]],
);
const CHANNEL_SETS = [['inbox'], ['push'], ['sms'], ['inbox', 'push', 'sms']];
const BIZ_ID = '900619746936498440^0';
const PLANNED = new Date('2026-10-24T08:00:00Z');
const SENT = new Date('2026-10-24T09:00:00Z');
const LOG_STATES = [
  { status: 'queued', suppress_reason: null, sent_at: null },
  { status: 'success', suppress_reason: null, sent_at: SENT },
  { status: 'failed', suppress_reason: null, sent_at: null },
  { status: 'failed', suppress_reason: null, sent_at: SENT },
  { status: 'suppressed', suppress_reason: 'push_disabled', sent_at: null },
];
const SENDABLE_STATES = LOG_STATES.filter((state) => state.status !== 'suppressed');
const BLANKS = [
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v',
  '\f',
  ' ',
  '　',
  ' \t\r\n　 ',
  // be-tc-2 (D10-355 ③): the Unicode spaces outside ASCII [:space:] that the CHECKs also reject.
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
  '\u2000\u200a',
  '\ufeff \u3000',
  ' \t\u0085\u00a0\u1680\u2029\u202f\u205f\r\n\ufeff',
];
const CREDENTIAL = /access|secret|credential|password/i;

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

async function requireSmsColumns(): Promise<void> {
  const expected = SMS_COLUMNS.map((name) => ({
    name,
    type: 'text',
    nullable: true,
    default_value: null,
  }));
  const templates = await columns('notify_templates');
  expect(templates, 'SMS registration columns').toEqual(expect.arrayContaining(expected));
  expect(await columns('notify_logs'), 'notify_logs has sms_biz_id').toContainEqual({
    name: 'sms_biz_id',
    type: 'text',
    nullable: true,
    default_value: null,
  });
}

function template(values: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    app_id: 'couli',
    code: `SMS_CHANNEL_${String(sequence)}`,
    variant: 'default',
    category: 'service',
    channels: ['inbox', 'push', 'sms'],
    ...values,
  };
}

async function insertTemplate(row: Record<string, unknown>, db = app) {
  const names = Object.keys(row);
  return sql<Record<string, unknown>>`
    INSERT INTO app.notify_templates (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(db);
}

async function updateTemplate(
  row: Record<string, unknown>,
  values: Record<string, unknown>,
  db = app,
) {
  return sql<Record<string, unknown>>`
    UPDATE app.notify_templates
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = ${row['variant']}
    RETURNING *
  `.execute(db);
}

async function storedTemplate(row: Record<string, unknown>) {
  const result = await sql<Record<string, unknown>>`
    SELECT * FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = ${row['variant']}
  `.execute(app);
  return result.rows;
}

function log(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    app_id: 'couli',
    user_id: null,
    code: 'WD_FAILED',
    channel: 'sms',
    dedupe_key: `sms-channel-${randomUUID()}`,
    planned_at: PLANNED,
    ...values,
  };
}

async function insertLog(row: Record<string, unknown>, db = app) {
  const names = Object.keys(row);
  return sql<Record<string, unknown>>`
    INSERT INTO app.notify_logs (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(db);
}

async function updateLog(id: unknown, values: Record<string, unknown>, db = app) {
  return sql<Record<string, unknown>>`UPDATE app.notify_logs
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id} RETURNING *
  `.execute(db);
}

async function storedLog(id: unknown) {
  const result = await sql<Record<string, unknown>>`
    SELECT * FROM app.notify_logs WHERE id = ${id}
  `.execute(app);
  return result.rows;
}

it('[AC-B1-12x#1] notify_templates gains exactly four nullable text SMS columns without defaults and no credential column', async () => {
  const metadata = await columns('notify_templates');
  expect(metadata.map(({ name, type, nullable }) => [name, type, nullable])).toEqual([
    ['app_id', 'text', false],
    ['body_override', 'text', true],
    ['category', 'text', false],
    ['channels', '_text', false],
    ['code', 'text', false],
    ['created_at', 'timestamptz', false],
    ['route', 'jsonb', true],
    ['row_version', 'int4', false],
    ['sms_pending_preview_text', 'text', true],
    ['sms_pending_sign_name', 'text', true],
    ['sms_pending_template_code', 'text', true],
    ['sms_pending_template_type', 'text', true],
    ['sms_preview_text', 'text', true],
    ['sms_sign_name', 'text', true],
    ['sms_template_code', 'text', true],
    ['sms_template_type', 'text', true],
    ['sms_test_status', 'text', true],
    ['sms_tested_at', 'timestamptz', true],
    ['title_override', 'text', true],
    ['updated_at', 'timestamptz', false],
    ['variant', 'text', false],
  ]);
  for (const name of SMS_COLUMNS) {
    const found = metadata.find((column) => column.name === name);
    expect(found, name).toBeDefined();
    expect(found?.default_value, name).toBeNull();
  }
  const credentials = metadata.filter((column) => CREDENTIAL.test(column.name));
  expect(credentials).toEqual([]);
});

it('[AC-B1-12x#2] notify_logs gains only nullable text sms_biz_id without a default', async () => {
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
    ['sms_biz_id', 'text', true],
    ['status', 'text', false],
    ['suppress_reason', 'text', true],
    ['updated_at', 'timestamptz', false],
    ['user_id', 'uuid', true],
  ]);
  const found = metadata.find((column) => column.name === 'sms_biz_id');
  expect(found).toBeDefined();
  expect(found?.default_value).toBeNull();
  const credentials = metadata.filter((column) => CREDENTIAL.test(column.name));
  expect(credentials).toEqual([]);
});

it('[AC-B1-12x#3] writes that omit the new columns read NULL and stay updatable for every category, channel set and log state', async () => {
  await requireSmsColumns();
  for (const category of ['service', 'subscription', 'marketing']) {
    for (const channels of CHANNEL_SETS) {
      const row = template({ category, channels });
      expect((await insertTemplate(row)).rows).toEqual([
        expect.objectContaining({ ...row, ...UNREGISTERED }),
      ]);
      const changed = await updateTemplate(row, {
        channels: ['inbox', 'push'],
        title_override: '新标题',
        row_version: 1,
      });
      expect(changed.rows).toEqual([
        expect.objectContaining({
          channels: ['inbox', 'push'],
          title_override: '新标题',
          row_version: 1,
          ...UNREGISTERED,
        }),
      ]);
    }
  }
  for (const channel of ['inbox', 'push', 'sms']) {
    for (const state of LOG_STATES) {
      const row = log({ channel, ...state });
      const saved = await insertLog(row);
      expect(saved.rows, JSON.stringify({ channel, state })).toEqual([
        expect.objectContaining({ ...row, sms_biz_id: null }),
      ]);
      expect(await storedLog(row['id'])).toEqual(saved.rows);
    }
    const queued = log({ channel });
    await insertLog(queued);
    const sent = await updateLog(queued['id'], {
      status: 'success',
      sent_at: SENT,
      row_version: 1,
    });
    expect(sent.rows).toEqual([
      expect.objectContaining({
        status: 'success',
        sent_at: SENT,
        row_version: 1,
        sms_biz_id: null,
      }),
    ]);
  }
});

it('[AC-B1-12x#4] couli_app registers, edits and clears a complete SMS registration per code and variant', async () => {
  await requireSmsColumns();
  for (const sms_template_type of ['verify', 'notice']) {
    for (const channels of CHANNEL_SETS) {
      const row = template({ channels, ...REGISTERED, sms_template_type });
      expect((await insertTemplate(row)).rows, JSON.stringify(row)).toEqual([
        expect.objectContaining(row),
      ]);
      expect(await storedTemplate(row)).toEqual([expect.objectContaining(row)]);
    }
  }
  for (const registration of [
    {
      sms_sign_name: '  凑狸  ',
      sms_template_code: 'SMS_0',
      sms_template_type: 'notice',
      sms_preview_text: '0',
    },
    {
      sms_sign_name: '凑狸科技',
      sms_template_code: 'SMS_480215033',
      sms_template_type: 'verify',
      sms_preview_text: '【凑狸】验证码 123456，5 分钟内有效。\n请勿告诉他人。\r\n',
    },
  ]) {
    const row = template(registration);
    expect((await insertTemplate(row)).rows).toEqual([expect.objectContaining(registration)]);
  }
  const row = template();
  await insertTemplate(row);
  expect((await updateTemplate(row, REGISTERED)).rows).toEqual([
    expect.objectContaining(REGISTERED),
  ]);
  const edited = {
    ...REGISTERED,
    sms_template_code: 'SMS_480215034',
    sms_template_type: 'verify',
    sms_preview_text: '【凑狸】验证码 654321。',
  };
  const changed = await updateTemplate(row, {
    sms_template_code: edited.sms_template_code,
    sms_template_type: edited.sms_template_type,
    sms_preview_text: edited.sms_preview_text,
  });
  expect(changed.rows).toEqual([expect.objectContaining(edited)]);
  // Switching SMS off is a channels change; the registration stays.
  expect((await updateTemplate(row, { channels: ['inbox'] })).rows).toEqual([
    expect.objectContaining({ channels: ['inbox'], ...edited }),
  ]);
  expect((await updateTemplate(row, UNREGISTERED)).rows).toEqual([
    expect.objectContaining(UNREGISTERED),
  ]);
  // One row per code × variant: editing one variant leaves the others and the other app intact.
  const base = template(REGISTERED);
  await insertTemplate({ ...base, variant: 'frozen' });
  await insertTemplate({ ...base, variant: 'unfrozen' });
  await insertTemplate({ ...base, variant: 'frozen', app_id: 'couli_two' });
  const frozen = { ...base, variant: 'frozen' };
  expect((await updateTemplate(frozen, { sms_template_code: 'SMS_99' })).rows).toHaveLength(1);
  const stored = await sql<{ app_id: string; variant: string; sms_template_code: string }>`
    SELECT app_id, variant, sms_template_code FROM app.notify_templates
    WHERE code = ${base['code']} ORDER BY app_id, variant
  `.execute(app);
  expect(stored.rows).toEqual([
    { app_id: 'couli', variant: 'frozen', sms_template_code: 'SMS_99' },
    { app_id: 'couli', variant: 'unfrozen', sms_template_code: REGISTERED.sms_template_code },
    { app_id: 'couli_two', variant: 'frozen', sms_template_code: REGISTERED.sms_template_code },
  ]);
});

it('[AC-B1-12x#5] sms_template_type accepts only verify or notice on insert and update', async () => {
  await requireSmsColumns();
  const row = template(REGISTERED);
  const saved = (await insertTemplate(row)).rows;
  for (const sms_template_type of [
    '',
    ' ',
    'VERIFY',
    'Verify',
    'NOTICE',
    'verify ',
    ' notice',
    'notice\n',
    'marketing',
    'promotion',
    'verification',
    'verify_code',
    '验证码',
    '通知',
  ]) {
    const values = { ...REGISTERED, sms_template_type };
    const label = JSON.stringify(values);
    expect(await sqlState(insertTemplate(template(values))), label).toBe('23514');
    expect(await sqlState(updateTemplate(row, { sms_template_type })), label).toBe('23514');
    expect(await storedTemplate(row)).toEqual(saved);
  }
});

it('[AC-B1-12x#6] the four registration columns are all NULL or all set, on insert and on update', async () => {
  await requireSmsColumns();
  const blank = template();
  const blankSaved = (await insertTemplate(blank)).rows;
  const full = template(REGISTERED);
  const fullSaved = (await insertTemplate(full)).rows;
  const origins = [
    { row: blank, saved: blankSaved, restore: UNREGISTERED },
    { row: full, saved: fullSaved, restore: REGISTERED },
  ];
  expect(SUBSETS).toHaveLength(16);
  for (const set of SUBSETS) {
    const values = Object.fromEntries(
      SMS_COLUMNS.map((name) => [name, set.includes(name) ? REGISTERED[name] : null] as const),
    );
    const valid = set.length === 0 || set.length === SMS_COLUMNS.length;
    const expected = valid ? 'no error' : '23514';
    const label = JSON.stringify(values);
    expect(await sqlState(insertTemplate(template(values))), label).toBe(expected);
    for (const { row, saved, restore } of origins) {
      expect(await sqlState(updateTemplate(row, values)), label).toBe(expected);
      if (valid) {
        expect(await storedTemplate(row)).toEqual([expect.objectContaining(values)]);
        expect(await sqlState(updateTemplate(row, restore))).toBe('no error');
      }
      expect(await storedTemplate(row)).toEqual(saved);
    }
  }
  // Clearing or setting a single column of a complete or empty registration is rejected as well.
  for (const name of SMS_COLUMNS) {
    const cleared = await sqlState(updateTemplate(full, { [name]: null }));
    const set = await sqlState(updateTemplate(blank, { [name]: REGISTERED[name] }));
    expect([cleared, set], name).toEqual(['23514', '23514']);
  }
  expect(await storedTemplate(full)).toEqual(fullSaved);
  expect(await storedTemplate(blank)).toEqual(blankSaved);
});

it('[AC-B1-12x#7] sign name, template CODE and preview text reject empty or whitespace-only values', async () => {
  await requireSmsColumns();
  const row = template(REGISTERED);
  const saved = (await insertTemplate(row)).rows;
  for (const name of ['sms_sign_name', 'sms_template_code', 'sms_preview_text']) {
    for (const value of BLANKS) {
      const values = { ...REGISTERED, [name]: value };
      const label = `${name} ${JSON.stringify(value)}`;
      expect(await sqlState(insertTemplate(template(values))), label).toBe('23514');
      expect(await sqlState(updateTemplate(row, { [name]: value })), label).toBe('23514');
      expect(await storedTemplate(row)).toEqual(saved);
    }
  }
});

it('[AC-B1-12x#8] SMS logs store a BizId verbatim on insert and update and may clear it', async () => {
  await requireSmsColumns();
  for (const state of SENDABLE_STATES) {
    const row = log({ ...state, sms_biz_id: BIZ_ID });
    const saved = await insertLog(row);
    expect(saved.rows, JSON.stringify(state)).toEqual([expect.objectContaining(row)]);
    expect(await storedLog(row['id'])).toEqual(saved.rows);
  }
  const row = log();
  await insertLog(row);
  const sent = await updateLog(row['id'], {
    status: 'success',
    sent_at: SENT,
    sms_biz_id: BIZ_ID,
    row_version: 1,
  });
  expect(sent.rows).toEqual([
    expect.objectContaining({ status: 'success', sent_at: SENT, sms_biz_id: BIZ_ID }),
  ]);
  for (const sms_biz_id of ['0', ' 900619746936498441^0 ', null]) {
    expect((await updateLog(row['id'], { sms_biz_id })).rows).toEqual([
      expect.objectContaining({ sms_biz_id }),
    ]);
  }
});

it('[AC-B1-12x#9] sms_biz_id is rejected on inbox and push rows and as an empty string', async () => {
  await requireSmsColumns();
  for (const channel of ['inbox', 'push']) {
    for (const state of LOG_STATES) {
      const values = { channel, ...state, sms_biz_id: BIZ_ID };
      expect(await sqlState(insertLog(log(values))), JSON.stringify(values)).toBe('23514');
    }
    const other = log({ channel });
    const saved = (await insertLog(other)).rows;
    expect(await sqlState(updateLog(other['id'], { sms_biz_id: BIZ_ID })), channel).toBe('23514');
    expect(await storedLog(other['id'])).toEqual(saved);
  }
  const sms = log({ status: 'success', sent_at: SENT, sms_biz_id: BIZ_ID });
  const saved = (await insertLog(sms)).rows;
  for (const channel of ['inbox', 'push']) {
    expect(await sqlState(updateLog(sms['id'], { channel })), channel).toBe('23514');
    expect(await storedLog(sms['id'])).toEqual(saved);
  }
  expect(await sqlState(insertLog(log({ sms_biz_id: '' })))).toBe('23514');
  expect(await sqlState(updateLog(sms['id'], { sms_biz_id: '' }))).toBe('23514');
  expect(await storedLog(sms['id'])).toEqual(saved);
  // The CHECK concerns the channel of the row only: moving it off SMS with a cleared BizId works.
  const moved = await updateLog(sms['id'], { channel: 'push', sms_biz_id: null });
  expect(moved.rows).toEqual([expect.objectContaining({ channel: 'push', sms_biz_id: null })]);
});

it('[AC-B1-12x#10] the new CHECKs are validated and existing keys and indexes are unchanged', async () => {
  await requireSmsColumns();
  for (const { table, names } of NEW_COLUMNS) {
    const checks = await sql<{ name: string; column_name: string; validated: boolean }>`
      SELECT c.conname AS name, a.attname::text AS column_name, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
    `.execute(app);
    const notValid = checks.rows.filter((check) => !check.validated);
    expect(notValid, `${table} has no NOT VALID CHECK`).toEqual([]);
    for (const name of names) {
      const covered = checks.rows.some((check) => check.column_name === name);
      expect(covered, `${table}.${name} has a CHECK`).toBe(true);
    }
  }
  const keys = await sql<{ relation: string; name: string; columns: string[] }>`
    SELECT t.relname::text AS relation, c.conname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord) AS columns
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname IN ('notify_templates', 'notify_logs')
      AND c.contype = 'p'
    ORDER BY t.relname
  `.execute(app);
  expect(keys.rows).toEqual([
    { relation: 'notify_logs', name: 'notify_logs_pkey', columns: ['id'] },
    {
      relation: 'notify_templates',
      name: 'notify_templates_pkey',
      columns: ['app_id', 'code', 'variant'],
    },
  ]);
  const indexes = await sql<{ name: string; columns: string[]; valid: boolean; partial: boolean }>`
    SELECT i.relname AS name, x.indisvalid AND x.indisready AS valid,
      x.indpred IS NOT NULL AS partial,
      ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE k.ord <= x.indnkeyatts ORDER BY k.ord) AS columns
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class i ON i.oid = x.indexrelid
    WHERE n.nspname = 'app' AND t.relname = 'notify_logs'
  `.execute(app);
  expect(indexes.rows).toEqual(
    expect.arrayContaining([
      {
        name: 'notify_logs_due_idx',
        columns: ['status', 'planned_at'],
        valid: true,
        partial: false,
      },
      {
        name: 'notify_logs_user_created_idx',
        columns: ['app_id', 'user_id', 'created_at'],
        valid: true,
        partial: false,
      },
    ]),
  );
  // (app_id, dedupe_key) stays unique whatever the BizId; registrations themselves are not unique.
  const delivered = { dedupe_key: `dedupe-${randomUUID()}`, status: 'success', sent_at: SENT };
  await insertLog(log({ ...delivered, sms_biz_id: BIZ_ID }));
  const duplicate = await sqlState(insertLog(log({ ...delivered, sms_biz_id: '1^0' })));
  expect(duplicate).toBe('23505');
  const base = template(REGISTERED);
  await insertTemplate(base);
  expect(await sqlState(insertTemplate({ ...base, variant: 'frozen' }))).toBe('no error');
  expect(await sqlState(insertTemplate({ ...base, app_id: 'couli_two' }))).toBe('no error');
  expect(await sqlState(insertTemplate(template(REGISTERED)))).toBe('no error');
  expect(await sqlState(insertTemplate(base))).toBe('23505');
});

it('[AC-B1-12x#11] the new columns inherit the table grants: couli_app writes, couli_readonly only reads', async () => {
  await requireSmsColumns();
  for (const { table, names } of NEW_COLUMNS) {
    for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const allowed =
          role === 'couli_app' || (role === 'couli_readonly' && privilege === 'SELECT');
        for (const name of names) {
          const result = await sql<{ allowed: boolean }>`SELECT
            has_column_privilege(${role}, ${`app.${table}`}, ${name}, ${privilege}) AS allowed
          `.execute(app);
          expect(result.rows, `${role} ${table}.${name} ${privilege}`).toEqual([{ allowed }]);
        }
      }
    }
  }
  const row = template(REGISTERED);
  await insertTemplate(row);
  const registration = await sql`
    SELECT sms_sign_name, sms_template_code, sms_template_type, sms_preview_text
    FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = 'default'
  `.execute(readonly);
  expect(registration.rows).toEqual([REGISTERED]);
  const entry = log({ status: 'success', sent_at: SENT, sms_biz_id: BIZ_ID });
  await insertLog(entry);
  const receipt = await sql`
    SELECT sms_biz_id FROM app.notify_logs WHERE id = ${entry['id']}
  `.execute(readonly);
  expect(receipt.rows).toEqual([{ sms_biz_id: BIZ_ID }]);
  const denied = [
    await sqlState(updateTemplate(row, { sms_template_code: 'SMS_1' }, readonly)),
    await sqlState(insertTemplate(template(REGISTERED), readonly)),
    await sqlState(updateLog(entry['id'], { sms_biz_id: '1^0' }, readonly)),
    await sqlState(insertLog(log({ sms_biz_id: BIZ_ID }), readonly)),
  ];
  expect(denied).toEqual(['42501', '42501', '42501', '42501']);
});

// be-tc-2 (D10-355 ③, B1-12x spec-test S2): no column anywhere in schema app may hold an Aliyun
// AccessKey or an SMS secret or key; the credential stays out of the database (BR-TEXT-20 细则).
const CREDENTIAL_COLUMN = /access_?key|sms.*(secret|key)/i;

it('[AC-B1-12x#21] no column of any table or view in schema app is named like an access key or an SMS secret or key', async () => {
  await requireSmsColumns();
  // The pattern itself catches the names it is meant to catch.
  const samples = ['access_key', 'AccessKey', 'aliyun_accesskey', 'sms_secret', 'sms_api_key'];
  expect(samples.filter((name) => CREDENTIAL_COLUMN.test(name))).toEqual(samples);
  const visible = await sql<{ relation: string; name: string }>`
    SELECT table_name::text AS relation, column_name::text AS name
    FROM information_schema.columns
    WHERE table_schema = 'app'
    ORDER BY table_name, column_name
  `.execute(app);
  // information_schema only lists columns the role can reach; pg_attribute lists them all.
  const catalog = await sql<{ relation: string; name: string }>`
    SELECT t.relname::text AS relation, a.attname::text AS name
    FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY t.relname, a.attname
  `.execute(app);
  for (const scan of [visible.rows, catalog.rows]) {
    expect(scan).toEqual(
      expect.arrayContaining([
        { relation: 'notify_templates', name: 'sms_sign_name' },
        { relation: 'notify_logs', name: 'sms_biz_id' },
      ]),
    );
    expect(scan.filter((column) => CREDENTIAL_COLUMN.test(column.name))).toEqual([]);
  }
});

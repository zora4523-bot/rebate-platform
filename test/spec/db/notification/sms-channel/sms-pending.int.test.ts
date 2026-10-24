// B1-12x, second pass: task supplement E (D10-337 ① / D10-339 ⑤, 04 §3 2026-10-24) on top of 08
// BR-TEXT-20 细则「短信渠道登记与后台渠道开关」(测试发送). The same code × variant row of
// notify_templates also keeps the registration awaiting its test send: pending sign name, template
// CODE, template type and preview text plus the test status and time, all NULL or all set, and
// independent of the four in-use columns that sms-channel.int.test.ts covers.
// Check the new columns in the catalog before DML: the unmigrated database must fail assertions.
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

const PENDING_COLUMNS = [
  'sms_pending_sign_name',
  'sms_pending_template_code',
  'sms_pending_template_type',
  'sms_pending_preview_text',
  'sms_test_status',
  'sms_tested_at',
] as const;
type PendingColumn = (typeof PENDING_COLUMNS)[number];
const PENDING_TYPES: Record<PendingColumn, string> = {
  sms_pending_sign_name: 'text',
  sms_pending_template_code: 'text',
  sms_pending_template_type: 'text',
  sms_pending_preview_text: 'text',
  sms_test_status: 'text',
  sms_tested_at: 'timestamptz',
};
const PENDING_TEXTS = [
  'sms_pending_sign_name',
  'sms_pending_template_code',
  'sms_pending_preview_text',
] as const;
const TESTED = new Date('2026-10-24T10:00:00Z');
const PENDING: Record<PendingColumn, unknown> = {
  sms_pending_sign_name: '凑狸科技',
  sms_pending_template_code: 'SMS_480215035',
  sms_pending_template_type: 'verify',
  sms_pending_preview_text: '【凑狸科技】验证码 123456，5 分钟内有效。',
  sms_test_status: 'accepted',
  sms_tested_at: TESTED,
};
const NO_PENDING: Record<PendingColumn, null> = {
  sms_pending_sign_name: null,
  sms_pending_template_code: null,
  sms_pending_template_type: null,
  sms_pending_preview_text: null,
  sms_test_status: null,
  sms_tested_at: null,
};
const IN_USE = {
  sms_sign_name: '凑狸',
  sms_template_code: 'SMS_154950909',
  sms_template_type: 'notice',
  sms_preview_text: '【凑狸】提现未成功，请到钱包查看原因。',
};
const NOT_IN_USE = {
  sms_sign_name: null,
  sms_template_code: null,
  sms_template_type: null,
  sms_preview_text: null,
};
const TEST_STATUSES = ['accepted', 'failed', 'not_sent_no_verify_phone'];
/** Every subset of the pending columns (the ones set; the others are NULL). */
const SUBSETS = PENDING_COLUMNS.reduce<PendingColumn[][]>(
  (subsets, name) => [...subsets, ...subsets.map((subset) => [...subset, name])],
  [[]],
);
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
  '\u2028',
  ' \t\r\n　',
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

async function requirePendingColumns(): Promise<void> {
  const expected = PENDING_COLUMNS.map((name) => ({
    name,
    type: PENDING_TYPES[name],
    nullable: true,
    default_value: null,
  }));
  expect(await columns('notify_templates'), 'pending SMS registration columns').toEqual(
    expect.arrayContaining(expected),
  );
}

function template(values: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    app_id: 'couli',
    code: `SMS_PENDING_${String(sequence)}`,
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

it('[AC-B1-12x#12] notify_templates gains exactly six nullable pending SMS columns without defaults and no credential column', async () => {
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
  for (const name of PENDING_COLUMNS) {
    const found = metadata.find((column) => column.name === name);
    expect(found, name).toBeDefined();
    expect(found?.default_value, name).toBeNull();
  }
  const credentials = metadata.filter((column) => CREDENTIAL.test(column.name));
  expect(credentials).toEqual([]);
});

it('[AC-B1-12x#13] writes that omit the pending columns read NULL and stay updatable, registered or not', async () => {
  await requirePendingColumns();
  for (const registration of [NOT_IN_USE, IN_USE]) {
    for (const category of ['service', 'subscription', 'marketing']) {
      const row = template({ category, ...registration });
      expect((await insertTemplate(row)).rows, JSON.stringify(row)).toEqual([
        expect.objectContaining({ ...row, ...NO_PENDING }),
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
          ...registration,
          ...NO_PENDING,
        }),
      ]);
    }
  }
});

it('[AC-B1-12x#14] in-use and pending registrations are independent: neither, either or both can be stored', async () => {
  await requirePendingColumns();
  const other = {
    ...PENDING,
    sms_pending_template_type: 'notice',
    sms_test_status: 'failed',
  };
  const combinations = [
    { ...NOT_IN_USE, ...NO_PENDING },
    { ...IN_USE, ...NO_PENDING },
    { ...NOT_IN_USE, ...PENDING },
    { ...IN_USE, ...PENDING },
    { ...IN_USE, ...other },
  ];
  for (const values of combinations) {
    const row = template(values);
    expect((await insertTemplate(row)).rows, JSON.stringify(values)).toEqual([
      expect.objectContaining(row),
    ]);
    expect(await storedTemplate(row)).toEqual([expect.objectContaining(values)]);
  }
  // A first registration waits for its test, is taken into use, then a new one waits beside it.
  const row = template();
  await insertTemplate(row);
  const steps = [
    PENDING,
    {
      sms_sign_name: PENDING.sms_pending_sign_name,
      sms_template_code: PENDING.sms_pending_template_code,
      sms_template_type: PENDING.sms_pending_template_type,
      sms_preview_text: PENDING.sms_pending_preview_text,
      ...NO_PENDING,
    },
    { ...PENDING, sms_pending_template_code: 'SMS_480215036', sms_test_status: 'failed' },
    {
      sms_test_status: 'not_sent_no_verify_phone',
      sms_tested_at: new Date('2026-10-24T11:00:00Z'),
    },
    NO_PENDING,
    NOT_IN_USE,
  ];
  let expected: Record<string, unknown> = { ...NOT_IN_USE, ...NO_PENDING };
  for (const values of steps) {
    expected = { ...expected, ...values };
    expect((await updateTemplate(row, values)).rows, JSON.stringify(values)).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(await storedTemplate(row)).toEqual([expect.objectContaining(expected)]);
  }
  expect(expected).toEqual({ ...NOT_IN_USE, ...NO_PENDING });
});

it('[AC-B1-12x#15] pending template type is verify or notice and test status is accepted, failed or not_sent_no_verify_phone', async () => {
  await requirePendingColumns();
  for (const sms_pending_template_type of ['verify', 'notice']) {
    for (const sms_test_status of TEST_STATUSES) {
      const values = { ...PENDING, sms_pending_template_type, sms_test_status };
      const row = template(values);
      expect((await insertTemplate(row)).rows, JSON.stringify(values)).toEqual([
        expect.objectContaining(values),
      ]);
    }
  }
  const row = template(PENDING);
  await insertTemplate(row);
  for (const sms_test_status of TEST_STATUSES) {
    expect((await updateTemplate(row, { sms_test_status })).rows).toEqual([
      expect.objectContaining({ sms_test_status }),
    ]);
  }
  const saved = await storedTemplate(row);
  const rejected = [
    ...[
      '',
      ' ',
      'VERIFY',
      'Notice',
      'verify ',
      ' notice',
      'notice\n',
      'marketing',
      'verification',
      '验证码',
      '通知',
    ].map((sms_pending_template_type) => ({ sms_pending_template_type })),
    ...[
      '',
      ' ',
      'ACCEPTED',
      'Accepted',
      'accepted ',
      'failed\n',
      'success',
      'pending',
      'unknown',
      'sent',
      'delivered',
      'not_sent',
      'no_verify_phone',
      'not_sent_no_verify_phone ',
      '受理成功',
    ].map((sms_test_status) => ({ sms_test_status })),
  ];
  for (const values of rejected) {
    const label = JSON.stringify(values);
    expect(await sqlState(insertTemplate(template({ ...PENDING, ...values }))), label).toBe(
      '23514',
    );
    expect(await sqlState(updateTemplate(row, values)), label).toBe('23514');
    expect(await storedTemplate(row)).toEqual(saved);
  }
});

it('[AC-B1-12x#16] the six pending columns are all NULL or all set, on insert and on update', async () => {
  await requirePendingColumns();
  const blank = template(IN_USE);
  const blankSaved = (await insertTemplate(blank)).rows;
  const full = template(PENDING);
  const fullSaved = (await insertTemplate(full)).rows;
  const origins = [
    { row: blank, saved: blankSaved, restore: NO_PENDING },
    { row: full, saved: fullSaved, restore: PENDING },
  ];
  expect(SUBSETS).toHaveLength(64);
  for (const set of SUBSETS) {
    const values = Object.fromEntries(
      PENDING_COLUMNS.map((name) => [name, set.includes(name) ? PENDING[name] : null] as const),
    );
    const valid = set.length === 0 || set.length === PENDING_COLUMNS.length;
    const expected = valid ? 'no error' : '23514';
    const label = JSON.stringify(values);
    expect(await sqlState(insertTemplate(template(values))), label).toBe(expected);
    expect(await sqlState(insertTemplate(template({ ...IN_USE, ...values }))), label).toBe(
      expected,
    );
    for (const { row, saved, restore } of origins) {
      expect(await sqlState(updateTemplate(row, values)), label).toBe(expected);
      if (valid) {
        expect(await storedTemplate(row)).toEqual([expect.objectContaining(values)]);
        expect(await sqlState(updateTemplate(row, restore))).toBe('no error');
      }
      expect(await storedTemplate(row)).toEqual(saved);
    }
  }
  // Clearing or setting a single column of a complete or empty pending registration is rejected.
  for (const name of PENDING_COLUMNS) {
    const cleared = await sqlState(updateTemplate(full, { [name]: null }));
    const set = await sqlState(updateTemplate(blank, { [name]: PENDING[name] }));
    expect([cleared, set], name).toEqual(['23514', '23514']);
  }
  expect(await storedTemplate(full)).toEqual(fullSaved);
  expect(await storedTemplate(blank)).toEqual(blankSaved);
});

it('[AC-B1-12x#17] a complete pending registration does not excuse a partial in-use one, nor the reverse', async () => {
  await requirePendingColumns();
  const inUseNames = Object.keys(IN_USE);
  for (const name of inUseNames) {
    const partial = { ...IN_USE, [name]: null };
    const label = `in use without ${name}`;
    expect(await sqlState(insertTemplate(template({ ...partial, ...PENDING }))), label).toBe(
      '23514',
    );
  }
  for (const name of PENDING_COLUMNS) {
    const partial = { ...PENDING, [name]: null };
    const label = `pending without ${name}`;
    expect(await sqlState(insertTemplate(template({ ...IN_USE, ...partial }))), label).toBe(
      '23514',
    );
  }
  const both = template({ ...IN_USE, ...PENDING });
  const saved = (await insertTemplate(both)).rows;
  for (const name of inUseNames) {
    expect(await sqlState(updateTemplate(both, { [name]: null })), name).toBe('23514');
  }
  for (const name of PENDING_COLUMNS) {
    expect(await sqlState(updateTemplate(both, { [name]: null })), name).toBe('23514');
  }
  expect(await storedTemplate(both)).toEqual(saved);
});

it('[AC-B1-12x#18] pending sign name, template CODE and preview text reject empty or whitespace-only values', async () => {
  await requirePendingColumns();
  const row = template(PENDING);
  const saved = (await insertTemplate(row)).rows;
  for (const name of PENDING_TEXTS) {
    for (const value of BLANKS) {
      const values = { ...PENDING, [name]: value };
      const label = `${name} ${JSON.stringify(value)}`;
      expect(await sqlState(insertTemplate(template(values))), label).toBe('23514');
      expect(await sqlState(updateTemplate(row, { [name]: value })), label).toBe('23514');
      expect(await storedTemplate(row)).toEqual(saved);
    }
  }
  const padded = {
    ...PENDING,
    sms_pending_sign_name: '  凑狸  ',
    sms_pending_template_code: 'SMS_0',
    sms_pending_preview_text: '【凑狸】验证码 654321。\n请勿告诉他人。\r\n',
  };
  expect((await insertTemplate(template(padded))).rows).toEqual([expect.objectContaining(padded)]);
});

it('[AC-B1-12x#19] the pending CHECKs are validated and cover every pending column; the key is unchanged', async () => {
  await requirePendingColumns();
  const checks = await sql<{ name: string; column_name: string; validated: boolean }>`
    SELECT c.conname AS name, a.attname::text AS column_name, c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'app' AND t.relname = 'notify_templates' AND c.contype = 'c'
  `.execute(app);
  const notValid = checks.rows.filter((check) => !check.validated);
  expect(notValid, 'notify_templates has no NOT VALID CHECK').toEqual([]);
  for (const name of PENDING_COLUMNS) {
    const covered = checks.rows.some((check) => check.column_name === name);
    expect(covered, `notify_templates.${name} has a CHECK`).toBe(true);
  }
  const keys = await sql<{ name: string; type: string; columns: string[] }>`
    SELECT c.conname::text AS name, c.contype::text AS type,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord) AS columns
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = 'notify_templates' AND c.contype IN ('p', 'u', 'x')
  `.execute(app);
  expect(keys.rows).toEqual([
    { name: 'notify_templates_pkey', type: 'p', columns: ['app_id', 'code', 'variant'] },
  ]);
  // Pending registrations themselves are not unique.
  const first = template({ ...IN_USE, ...PENDING });
  await insertTemplate(first);
  expect(await sqlState(insertTemplate({ ...first, variant: 'frozen' }))).toBe('no error');
  expect(await sqlState(insertTemplate(template({ ...IN_USE, ...PENDING })))).toBe('no error');
  expect(await sqlState(insertTemplate(first))).toBe('23505');
});

it('[AC-B1-12x#20] the pending columns inherit the table grants: couli_app writes, couli_readonly only reads', async () => {
  await requirePendingColumns();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      const allowed = role === 'couli_app' || (role === 'couli_readonly' && privilege === 'SELECT');
      for (const name of PENDING_COLUMNS) {
        const result = await sql<{ allowed: boolean }>`SELECT
          has_column_privilege(${role}, ${'app.notify_templates'}, ${name}, ${privilege}) AS allowed
        `.execute(app);
        expect(result.rows, `${role} notify_templates.${name} ${privilege}`).toEqual([{ allowed }]);
      }
    }
  }
  const row = template(PENDING);
  await insertTemplate(row);
  const pending = await sql`
    SELECT sms_pending_sign_name, sms_pending_template_code, sms_pending_template_type,
           sms_pending_preview_text, sms_test_status, sms_tested_at
    FROM app.notify_templates
    WHERE app_id = ${row['app_id']} AND code = ${row['code']} AND variant = 'default'
  `.execute(readonly);
  expect(pending.rows).toEqual([PENDING]);
  const denied = [
    await sqlState(updateTemplate(row, { sms_test_status: 'failed' }, readonly)),
    await sqlState(insertTemplate(template(PENDING), readonly)),
  ];
  expect(denied).toEqual(['42501', '42501']);
  expect(await storedTemplate(row)).toEqual([expect.objectContaining(PENDING)]);
});

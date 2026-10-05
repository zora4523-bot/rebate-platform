// F1-06a: 04 §3.2 and the task's explicit migration rulings; BR-ID-33/34/30 only
// insofar as they define this schema. Login, step-up, encryption, masking and retention jobs
// belong to their writers, not this migration. AC-F1-06a#n are local rule-test identifiers.
// All connections are business roles; missing tables fail assertions inside each test.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  TABLES,
  adminReference,
  column,
  columns,
  foreignKeys,
  fresh,
  insertRow,
  keys,
  literals,
  newAdmin,
  newPermission,
  sqlState,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let payout: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
});

afterAll(async () => {
  await Promise.all([app, readonly, payout, maint].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

it('[AC-F1-06a#1] all three baseline tables have app_id NOT NULL', async () => {
  for (const table of TABLES) {
    expect((await column(app, table, 'app_id')).nullable, table).toBe(false);
  }
});

it('[AC-F1-06a#2] admin_users contains the specified security columns and no plaintext secrets', async () => {
  const cols = await columns(app, 'admin_users');
  for (const name of [
    'totp_secret_cipher',
    'totp_bound_at',
    'is_super',
    'status',
    'verify_phone_cipher',
    'verify_phone_hmac',
    'verify_phone_set_at',
  ])
    expect(
      cols.map((c) => c.name),
      name,
    ).toContain(name);
  expect(await column(app, 'admin_users', 'is_super')).toMatchObject({
    type: 'bool',
    nullable: false,
  });
  expect((await column(app, 'admin_users', 'status')).nullable).toBe(false);
  // The account name and hash may have arbitrary names. Apart from the account name and
  // specified columns there must be required opaque credential storage. Hash computation
  // itself is the writer's responsibility and cannot be proved by a column's spelling.
  const loginName = await accountColumn();
  const credentialColumns = cols.filter(
    (c) =>
      ![
        loginName,
        'app_id',
        'status',
        'totp_secret_cipher',
        'verify_phone_cipher',
        'verify_phone_hmac',
      ].includes(c.name) &&
      ['text', 'varchar', 'bpchar', 'bytea'].includes(c.type) &&
      !c.nullable,
  );
  expect(credentialColumns.length, 'required password-hash storage').toBeGreaterThan(0);
  for (const c of cols) {
    expect(c.name).not.toMatch(
      /^(?:password|passwd|pwd|totp|totp_secret|totp_seed|phone|phone_number|verify_phone|verify_phone_number)$/i,
    );
    expect(c.name).not.toMatch(
      /(?:password|passwd|totp|phone).*(?:plain|raw|clear)|(?:plain|raw|clear).*(?:password|passwd|totp|phone)/i,
    );
  }
});

it('[AC-F1-06a#3] an account may start without TOTP binding or a registered verification phone', async () => {
  for (const name of [
    'totp_secret_cipher',
    'totp_bound_at',
    'verify_phone_cipher',
    'verify_phone_hmac',
    'verify_phone_set_at',
  ]) {
    expect((await column(app, 'admin_users', name)).nullable, name).toBe(true);
  }
  const row = await newAdmin(app);
  for (const name of [
    'totp_secret_cipher',
    'totp_bound_at',
    'verify_phone_cipher',
    'verify_phone_hmac',
    'verify_phone_set_at',
  ]) {
    expect(row[name], name).toBeNull();
  }
});

it('[AC-F1-06a#4] binding, phone registration, grant and audit times are supplied by the writer', async () => {
  for (const [table, name] of [
    ['admin_users', 'totp_bound_at'],
    ['admin_users', 'verify_phone_set_at'],
    ['admin_permissions', 'granted_at'],
    ['audit_logs', 'at'],
  ] as const) {
    expect(await column(app, table, name)).toMatchObject({ type: 'timestamptz', defaulted: false });
  }
});

async function accountColumn(): Promise<string> {
  const cols = await columns(app, 'admin_users');
  const uniqueKeys = await keys(app, 'admin_users');
  // The sole-column, unconditional string key identifies the implementation-chosen login name.
  const candidates = cols.filter(
    (c) =>
      ['text', 'varchar', 'citext'].includes(c.type) &&
      !c.nullable &&
      !['app_id', 'status', 'verify_phone_hmac'].includes(c.name) &&
      !/(?:hash|digest|cipher)/i.test(c.name) &&
      uniqueKeys.some(
        (k) => !k.partial && !k.expression && k.columns.length === 1 && k.columns[0] === c.name,
      ),
  );
  expect(candidates.length, 'global, nonpartial account-name uniqueness').toBeGreaterThan(0);
  return candidates[0]!.name;
}

it('[AC-F1-06a#5] account names are globally unique across apps and every status, including disabled accounts', async () => {
  const name = await accountColumn();
  const login = fresh();
  const statuses = await literals(app, 'admin_users', 'status');
  const row = await newAdmin(app, { [name]: login });
  // A nonpartial unique index already proves disabled names remain reserved. Also exercise
  // every declared status (without inventing active/disabled enum spellings).
  for (const status of new Set([row['status'], ...statuses])) {
    await sql`UPDATE app.admin_users SET status = ${status} WHERE ${sql.ref(name)} = ${login}`.execute(
      app,
    );
    for (const appId of ['couli', 'couli_two']) {
      expect(await sqlState(newAdmin(app, { app_id: appId, [name]: login }))).toBe('23505');
    }
  }
  expect(await sqlState(newAdmin(app, { [name]: fresh() }))).toBe('no error');
});

it('[AC-F1-06a#6] admin_permissions contains the grant fields and an unconditional three-column unique key', async () => {
  for (const name of ['admin_id', 'permission_key', 'granted_by', 'granted_at']) {
    expect((await column(app, 'admin_permissions', name)).nullable, name).toBe(false);
  }
  expect(await keys(app, 'admin_permissions')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        columns: ['app_id', 'admin_id', 'permission_key'],
        partial: false,
        expression: false,
      }),
    ]),
  );
});

it('[AC-F1-06a#7] duplicate permission grants fail even with another grantor or grant time', async () => {
  const admin = await newAdmin(app);
  const grantor = await newAdmin(app, { is_super: true });
  const otherGrantor = await newAdmin(app, { is_super: true });
  await newPermission(app, admin, grantor);
  expect(
    await sqlState(
      newPermission(app, admin, otherGrantor, {
        granted_at: new Date('2026-10-06T08:00:00Z'),
      }),
    ),
  ).toBe('23505');
  expect(
    await sqlState(newPermission(app, admin, grantor, { permission_key: 'user.lookup' })),
  ).toBe('no error');
  expect(await sqlState(newPermission(app, await newAdmin(app), grantor))).toBe('no error');
  expect(
    await sqlState(
      newPermission(
        app,
        await newAdmin(app, { app_id: 'couli_two' }),
        await newAdmin(app, { app_id: 'couli_two', is_super: true }),
        { app_id: 'couli_two' },
      ),
    ),
  ).toBe('no error');
});

it('[AC-F1-06a#8] permission keys stay open for future contract additions, without a CHECK or database enum', async () => {
  const c = await column(app, 'admin_permissions', 'permission_key');
  expect(['text', 'varchar']).toContain(c.type);
  const checks = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'app.admin_permissions'::regclass AND contype = 'c'
  `.execute(app);
  expect(checks.rows.filter((r) => /\bpermission_key\b/.test(r.def))).toEqual([]);
  expect(
    await sqlState(
      newPermission(app, await newAdmin(app), await newAdmin(app, { is_super: true }), {
        permission_key: 'fixture.future_permission',
      }),
    ),
  ).toBe('no error');
});

it('[AC-F1-06a#9] grants can be revoked and granted again by the admin writer', async () => {
  const admin = await newAdmin(app);
  const grantor = await newAdmin(app, { is_super: true });
  const row = await newPermission(app, admin, grantor);
  const removed = await sql`DELETE FROM app.admin_permissions
    WHERE app_id = ${row['app_id']} AND admin_id = ${row['admin_id']}
      AND permission_key = ${row['permission_key']}`.execute(app);
  expect(removed.numAffectedRows).toBe(1n);
  expect(await sqlState(newPermission(app, admin, grantor))).toBe('no error');
});

it('[AC-F1-06a#10] audit_logs has all audit fields, JSONB before/after, and is not partitioned', async () => {
  for (const name of ['admin_id', 'action', 'target', 'before', 'after', 'ip', 'at']) {
    await column(app, 'audit_logs', name);
  }
  for (const name of ['before', 'after']) {
    expect((await column(app, 'audit_logs', name)).type).toBe('jsonb');
  }
  const kind = await sql<{ kind: string }>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = 'app.audit_logs'::regclass
  `.execute(app);
  expect(kind.rows).toEqual([{ kind: 'r' }]);
});

async function newAudit(): Promise<Record<string, unknown>> {
  const admin = await newAdmin(app);
  const key = await adminReference(app, 'audit_logs', 'admin_id');
  return insertRow(app, 'audit_logs', {
    app_id: 'couli',
    admin_id: admin[key],
    action: 'fixture.permission_granted',
    target: fresh(),
    before: JSON.stringify({ verify_phone: '138****5678' }),
    after: JSON.stringify({ permission_key: 'user.list' }),
    ip: '192.0.2.1',
    at: AT,
  });
}

it('[AC-F1-06a#11] the writer inserts audit entries; UPDATE and DELETE fail and preserve the entry', async () => {
  const row = await newAudit();
  const stored = () =>
    sql<Record<string, unknown>>`SELECT * FROM app.audit_logs
    WHERE app_id = 'couli' AND target = ${row['target']}`.execute(app);
  expect((await stored()).rows).toEqual([row]);
  expect(
    await sqlState(
      sql`UPDATE app.audit_logs SET action = 'fixture.tampered'
    WHERE app_id = 'couli' AND target = ${row['target']}`.execute(app),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.audit_logs
    WHERE app_id = 'couli' AND target = ${row['target']}`.execute(app),
    ),
  ).toBe('42501');
  expect((await stored()).rows).toEqual([row]);
});

it('[AC-F1-06a#12] audit_logs has enabled unconditional rejection triggers for both UPDATE and DELETE', async () => {
  await columns(app, 'audit_logs');
  // ACL rejection happens before triggers. Inspect trigger wiring separately, without granting
  // privileges or using the owner role. RAISE is checked in the attached function, not its name.
  const triggers = await sql<{
    events: number;
    enabled: string;
    unconditional: boolean;
    body: string;
  }>`
    SELECT t.tgtype::int AS events, t.tgenabled::text AS enabled,
           t.tgqual IS NULL AS unconditional, p.prosrc AS body
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'app.audit_logs'::regclass AND NOT t.tgisinternal
  `.execute(app);
  for (const event of [8, 16]) {
    const guards = triggers.rows.filter(
      (t) => (t.events & event) !== 0 && ['O', 'A'].includes(t.enabled) && t.unconditional,
    );
    expect(guards.length, `trigger event bit ${event}`).toBeGreaterThan(0);
    expect(guards.some((t) => /\bRAISE\s+(?:EXCEPTION|SQLSTATE)\b/i.test(t.body))).toBe(true);
  }
});

it('[AC-F1-06a#13] grants, grantors, audit actors and union auth_renewed_by reference admin_users without cascading', async () => {
  await columns(app, 'admin_users');
  for (const [table, name] of [
    ['admin_permissions', 'admin_id'],
    ['admin_permissions', 'granted_by'],
    ['audit_logs', 'admin_id'],
    ['union_accounts', 'auth_renewed_by'],
  ] as const) {
    await adminReference(app, table, name);
    for (const fk of await foreignKeys(app, table)) {
      expect(fk.validated, `${table} ${fk.columns.join(',')}`).toBe(true);
      expect(['a', 'r'], `${table} ON DELETE`).toContain(fk.onDelete);
      expect(['a', 'r'], `${table} ON UPDATE`).toContain(fk.onUpdate);
    }
  }
  for (const fk of await foreignKeys(app, 'admin_users')) {
    expect(['a', 'r']).toContain(fk.onDelete);
    expect(['a', 'r']).toContain(fk.onUpdate);
  }
});

async function privilege(role: string, table: string, priv: string, columnLevel = false) {
  const result = columnLevel
    ? await sql<{
        held: boolean;
      }>`SELECT has_any_column_privilege(${role}, ${`app.${table}`}, ${priv}) AS held`.execute(app)
    : await sql<{
        held: boolean;
      }>`SELECT has_table_privilege(${role}, ${`app.${table}`}, ${priv}) AS held`.execute(app);
  return result.rows[0]?.held;
}

it('[AC-F1-06a#14] the admin writer and readonly reader have the required grants; audit logs never grant mutation', async () => {
  for (const table of TABLES) {
    await columns(app, table);
    for (const priv of ['SELECT', 'INSERT'])
      expect(await privilege('couli_app', table, priv)).toBe(true);
    expect(await privilege('couli_readonly', table, 'SELECT')).toBe(true);
    expect(await privilege('couli_app', table, 'TRUNCATE')).toBe(false);
  }
  expect(await privilege('couli_app', 'admin_users', 'UPDATE', true)).toBe(true);
  expect(await privilege('couli_app', 'admin_permissions', 'DELETE')).toBe(true);
  for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    expect(await privilege('couli_app', 'audit_logs', priv)).toBe(false);
  }
  expect(await privilege('couli_app', 'audit_logs', 'UPDATE', true)).toBe(false);
});

it('[AC-F1-06a#15] readonly, payout and maintenance roles cannot write any admin baseline table', async () => {
  for (const table of TABLES) {
    await columns(app, table);
    for (const [role, db] of [
      ['couli_readonly', readonly],
      ['couli_payout', payout],
      ['couli_maint', maint],
    ] as const) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await privilege(role, table, priv), `${role} ${table} ${priv}`).toBe(false);
      }
      for (const priv of ['INSERT', 'UPDATE']) {
        expect(await privilege(role, table, priv, true), `${role} ${table} column ${priv}`).toBe(
          false,
        );
      }
      expect(
        await sqlState(
          sql`INSERT INTO ${sql.table(`app.${table}`)} (app_id)
        SELECT 'couli' WHERE false`.execute(db),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = 'couli'
        WHERE false`.execute(db),
        ),
      ).toBe('42501');
      expect(
        await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE false`.execute(db)),
      ).toBe('42501');
    }
  }
});

it('[AC-F1-06a#16] triggers only guard UPDATE/DELETE; no trigger is attached specifically to is_super', async () => {
  for (const table of TABLES) {
    await columns(app, table);
    const triggers = await sql<{ events: number; superColumn: boolean }>`
      SELECT t.tgtype::int AS events,
             EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr)
                       AND a.attname = 'is_super') AS "superColumn"
      FROM pg_trigger t WHERE t.tgrelid = ${`app.${table}`}::regclass AND NOT t.tgisinternal
    `.execute(app);
    for (const t of triggers.rows) {
      expect(t.events & (4 | 32 | 64), table).toBe(0);
      expect(t.events & (8 | 16), table).toBeGreaterThan(0);
      expect(t.superColumn, table).toBe(false);
    }
  }
});

it('[AC-F1-06a#17] bound TOTP and a registered verification phone can store opaque ciphertext and supplied times', async () => {
  // Synthetic envelope only: this tests storage, not encryption correctness or real secrets.
  const envelope = JSON.stringify({ key_version: 1, ciphertext: 'c3ludGhldGljLW9ubHk=' });
  const values: Record<string, unknown> = {
    totp_bound_at: AT,
    verify_phone_set_at: AT,
  };
  const expected: Record<string, unknown> = { ...values };
  for (const name of ['totp_secret_cipher', 'verify_phone_cipher']) {
    const c = await column(app, 'admin_users', name);
    expect(['bytea', 'text', 'varchar', 'json', 'jsonb'], name).toContain(c.type);
    values[name] = c.type === 'bytea' ? Buffer.from(envelope) : envelope;
    expected[name] = ['json', 'jsonb'].includes(c.type) ? JSON.parse(envelope) : values[name];
  }
  const hmac = 'ab'.repeat(32);
  const hmacColumn = await column(app, 'admin_users', 'verify_phone_hmac');
  expect(['bytea', 'text', 'varchar', 'bpchar']).toContain(hmacColumn.type);
  values['verify_phone_hmac'] = hmacColumn.type === 'bytea' ? Buffer.from(hmac, 'hex') : hmac;
  expected['verify_phone_hmac'] = values['verify_phone_hmac'];
  expect(await newAdmin(app, values)).toMatchObject(expected);
});

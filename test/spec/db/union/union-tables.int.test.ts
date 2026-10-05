// B1-19a, SPEC_REF 1955639: 04 §3.2; 02 §6.2–6.3; BR-ATTR-02/28/03, BR-ID-24;
// ADR-0001 §4 and the task's migration adjudications. Database storage only: cron, SMS,
// step-up, audit, AF-07, order attribution and application transitions belong to later tasks.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  CIPHER,
  EXPIRES,
  TABLES,
  accountKey,
  cipherColumns,
  columns,
  foreignKeys,
  insertRow,
  pidScenes,
  sqlState,
  type Table,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function shape(table: Table, name: string, types: string[], nullable?: boolean) {
  const col = (await columns(app, table)).find((c) => c.name === name);
  expect(col, `${table}.${name}`).toBeDefined();
  expect(types, `${table}.${name} type`).toContain(col?.type);
  if (nullable !== undefined) expect(col?.nullable, `${table}.${name} nullable`).toBe(nullable);
}

async function updatePid(row: Record<string, unknown>, values: Record<string, unknown>) {
  return sql`
    UPDATE app.union_pids SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE app_id = ${row['app_id']} AND platform = ${row['platform']} AND pid = ${row['pid']}
  `.execute(app);
}

async function storedPid(row: Record<string, unknown>) {
  return (
    await sql<Record<string, unknown>>`
    SELECT * FROM app.union_pids WHERE app_id = ${row['app_id']}
      AND platform = ${row['platform']} AND pid = ${row['pid']}
  `.execute(app)
  ).rows;
}

it('[AC-B1-19a#1] three union tables exist with NOT NULL text app_id', async () => {
  for (const table of TABLES) {
    await shape(table, 'app_id', ['text'], false);
    expect(await sqlState(insertRow(app, table, { app_id: null })), table).toBe('23502');
  }
});

it('[AC-B1-19a#2] accounts retain authorization, renewal and probe columns with suitable types', async () => {
  for (const name of ['platform', 'status', 'auth_status', 'alert_stage', 'last_probe_error'])
    await shape('union_accounts', name, ['text']);
  for (const name of ['sync_start_at', 'auth_expires_at', 'auth_renewed_at', 'last_probe_at'])
    await shape('union_accounts', name, ['timestamptz']);
  await shape('union_accounts', 'auth_renewed_by', ['uuid'], true);
  await shape('union_accounts', 'last_probe_ok', ['bool'], true);
  const cols = await columns(app, 'union_accounts');
  // 04 describes an account name without fixing its SQL spelling.
  expect(
    cols.some((c) => /name|account/.test(c.name) && c.type === 'text'),
    'account name storage',
  ).toBe(true);
});

it('[AC-B1-19a#3] pid identity, scenes and HJY evidence columns exist', async () => {
  for (const name of ['platform', 'pid', 'pid_scene', 'status'])
    await shape('union_pids', name, ['text'], false);
  await shape('union_pids', 'union_account_id', ['uuid'], false);
  await shape('union_pids', 'site_id', ['text'], true);
  await shape('union_pids', 'hjy_ignore_confirmed_at', ['timestamptz'], true);
  await shape('union_pids', 'hjy_ignore_evidence_path', ['text'], true);
});

it('[AC-B1-19a#4] credentials store versioned ciphertext and expiry without plaintext token columns', async () => {
  await shape('union_credentials', 'expires_at', ['timestamptz']);
  const cols = await columns(app, 'union_credentials');
  const ciphers = cipherColumns(cols);
  expect(ciphers.length, 'encrypted token storage').toBeGreaterThan(0);
  // Either separate access/refresh ciphertexts or a shared encrypted token envelope is valid.
  const separate = ['access', 'refresh'].every((part) =>
    ciphers.some((c) => c.name.includes(part)),
  );
  const shared = ciphers.some(
    (c) => /token|credential/.test(c.name) && !/access|refresh/.test(c.name),
  );
  expect(separate || shared, 'access and refresh tokens have encrypted storage').toBe(true);
  for (const col of ciphers) expect(['bytea', 'text'], col.name).toContain(col.type);
  expect(
    cols
      .filter(
        (c) =>
          /token|secret|plaintext|plain_text/.test(c.name) &&
          !/cipher|encrypt|key_version/.test(c.name),
      )
      .map((c) => c.name),
  ).toEqual([]);
  const row = await insertRow(app, 'union_credentials');
  for (const col of ciphers) {
    expect(row[col.name], col.name).toEqual(col.type === 'bytea' ? Buffer.from(CIPHER) : CIPHER);
  }
  expect(row['expires_at']).toEqual(EXPIRES);
});

for (const [column, allowed] of [
  ['auth_status', ['active', 'expiring', 'expired']],
  ['alert_stage', ['none', 'd14', 'd7', 'd1', 'expired']],
] as const) {
  it(`[AC-B1-19a#${column === 'auth_status' ? '5' : '6'}] ${column} accepts exactly the specified CHECK domain`, async () => {
    await shape('union_accounts', column, ['text'], false);
    const checks = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = to_regclass('app.union_accounts') AND c.contype = 'c'
        AND cardinality(c.conkey) = 1 AND a.attname = ${column}
    `.execute(app);
    const labels = checks.rows.flatMap(({ definition }) =>
      [...definition.matchAll(/'([^']*)'/g)].map((m) => m[1]!),
    );
    expect([...new Set(labels)].sort()).toEqual([...allowed].sort());
    for (const value of allowed)
      expect(await sqlState(insertRow(app, 'union_accounts', { [column]: value })), value).toBe(
        'no error',
      );
    for (const value of ['invalid', '', allowed[0].toUpperCase()])
      expect(await sqlState(insertRow(app, 'union_accounts', { [column]: value })), value).toBe(
        '23514',
      );
  });
}

it('[AC-B1-19a#7] account status stays open text and account names are not made business-unique', async () => {
  const row = await insertRow(app, 'union_accounts');
  const keys = await sql<{ cols: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(num)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS cols
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.union_accounts') AND c.contype = 'p'
  `.execute(app);
  expect(keys.rows).toHaveLength(1);
  const primary = keys.rows.flatMap((r) => r.cols);
  const copy = Object.fromEntries(Object.entries(row).filter(([name]) => !primary.includes(name)));
  expect(await sqlState(insertRow(app, 'union_accounts', copy))).toBe('no error');
  expect(
    await sqlState(insertRow(app, 'union_accounts', { status: 'future-account-status' })),
  ).toBe('no error');
});

it('[AC-B1-19a#8] pending is the default and can omit both HJY evidence fields', async () => {
  const row = await insertRow(
    app,
    'union_pids',
    { hjy_ignore_confirmed_at: null, hjy_ignore_evidence_path: null },
    ['status'],
  );
  expect(row['status']).toBe('pending');
  expect(row['hjy_ignore_confirmed_at']).toBeNull();
  expect(row['hjy_ignore_evidence_path']).toBeNull();
});

it('[AC-B1-19a#9] pid statuses and scenes accept specified values and reject unknown values', async () => {
  await columns(app, 'union_pids');
  for (const status of ['pending', 'active', 'retired']) {
    expect(
      await sqlState(
        insertRow(app, 'union_pids', {
          status,
          hjy_ignore_confirmed_at: AT,
          hjy_ignore_evidence_path: 'fixtures/hjy-confirmed.png',
        }),
      ),
      status,
    ).toBe('no error');
  }
  for (const pid_scene of pidScenes())
    expect(await sqlState(insertRow(app, 'union_pids', { pid_scene })), pid_scene).toBe('no error');
  for (const [column, invalid] of [
    ['status', ['deleted', 'ACTIVE', '']],
    ['pid_scene', ['search', 'SELF_BUY', '']],
  ] as const) {
    for (const value of invalid)
      expect(
        await sqlState(
          insertRow(app, 'union_pids', {
            [column]: value,
            hjy_ignore_confirmed_at: AT,
            hjy_ignore_evidence_path: 'fixtures/hjy-confirmed.png',
          }),
        ),
        `${column}=${value}`,
      ).toBe('23514');
  }
});

it('[AC-B1-19a#10] both active and retired require each HJY evidence field on INSERT', async () => {
  await columns(app, 'union_pids');
  for (const status of ['active', 'retired']) {
    for (const [confirmed, path] of [
      [null, null],
      [AT, null],
      [null, 'fixtures/hjy.png'],
    ] as const) {
      expect(
        await sqlState(
          insertRow(app, 'union_pids', {
            status,
            hjy_ignore_confirmed_at: confirmed,
            hjy_ignore_evidence_path: path,
          }),
        ),
        `${status}: ${String(confirmed)} / ${String(path)}`,
      ).toBe('23514');
    }
  }
});

it('[AC-B1-19a#11] activation rejects partial evidence; valid activation and retirement retain evidence', async () => {
  for (const [confirmed, path] of [
    [null, null],
    [AT, null],
    [null, 'fixtures/hjy.png'],
  ] as const) {
    const row = await insertRow(app, 'union_pids', {
      status: 'pending',
      hjy_ignore_confirmed_at: confirmed,
      hjy_ignore_evidence_path: path,
    });
    expect(await sqlState(updatePid(row, { status: 'active' }))).toBe('23514');
    expect((await storedPid(row))[0]?.['status']).toBe('pending');
    expect(
      await sqlState(
        updatePid(row, {
          status: 'active',
          hjy_ignore_confirmed_at: AT,
          hjy_ignore_evidence_path: 'fixtures/hjy.png',
        }),
      ),
    ).toBe('no error');
    for (const status of ['active', 'retired']) {
      expect(await sqlState(updatePid(row, { status }))).toBe('no error');
      for (const name of ['hjy_ignore_confirmed_at', 'hjy_ignore_evidence_path'])
        expect(await sqlState(updatePid(row, { [name]: null })), `${status}.${name}`).toBe('23514');
      expect((await storedPid(row))[0]).toMatchObject({
        status,
        hjy_ignore_confirmed_at: AT,
        hjy_ignore_evidence_path: 'fixtures/hjy.png',
      });
    }
  }
});

it('[AC-B1-19a#12] pid uniqueness is app × platform × pid across accounts, sites, scenes and statuses', async () => {
  const pid = `mm_1_2_${randomUUID()}`;
  await insertRow(app, 'union_pids', { platform: 'taobao', pid, site_id: '2' });
  // Each insertion creates a fresh account: account_id cannot widen this unique key.
  for (const status of ['pending', 'active', 'retired']) {
    expect(
      await sqlState(
        insertRow(app, 'union_pids', {
          platform: 'taobao',
          pid,
          site_id: '3',
          pid_scene: 'share',
          status,
          hjy_ignore_confirmed_at: AT,
          hjy_ignore_evidence_path: 'fixtures/hjy.png',
        }),
      ),
      status,
    ).toBe('23505');
  }
  expect(
    await sqlState(
      insertRow(app, 'union_pids', { app_id: 'couli_two', platform: 'taobao', pid, site_id: '2' }),
    ),
  ).toBe('no error');
  expect(await sqlState(insertRow(app, 'union_pids', { platform: 'jd', pid }))).toBe('no error');
  const other = await insertRow(app, 'union_pids', { platform: 'taobao', site_id: '2' });
  expect(await sqlState(updatePid(other, { pid }))).toBe('23505');
});

it('[AC-B1-19a#13] concurrent pid registration has exactly one winner at the PG unique constraint', async () => {
  await columns(app, 'union_pids');
  const pid = `concurrent-${randomUUID()}`;
  const results = await Promise.all(
    [1, 2].map(() => sqlState(insertRow(app, 'union_pids', { pid }))),
  );
  expect(results.sort()).toEqual(['23505', 'no error']);
});

it('[AC-B1-19a#14] pid DELETE and TRUNCATE are denied and all three statuses remain in storage', async () => {
  for (const status of ['pending', 'active', 'retired']) {
    const row = await insertRow(app, 'union_pids', {
      status,
      hjy_ignore_confirmed_at: AT,
      hjy_ignore_evidence_path: 'fixtures/hjy.png',
    });
    expect(
      await sqlState(sql`DELETE FROM app.union_pids WHERE pid = ${row['pid']}`.execute(app)),
    ).toBe('42501');
    expect(await storedPid(row)).toEqual([row]);
  }
  expect(await sqlState(sql`TRUNCATE app.union_pids`.execute(app))).toBe('42501');
});

it('[AC-B1-19a#15] pid DELETE also has an enabled unconditional trigger, independent of grants', async () => {
  await columns(app, 'union_pids');
  // No DDL/owner connection is allowed in rule tests. Verify the independent trigger guard
  // in the catalog; #14 verifies the effective business-role prohibition with real statements.
  const triggers = await sql<{ enabled: string; event: number; unconditional: boolean }>`
    SELECT tgenabled::text AS enabled, tgtype::integer AS event, tgqual IS NULL AS unconditional
    FROM pg_trigger WHERE tgrelid = to_regclass('app.union_pids') AND NOT tgisinternal
  `.execute(app);
  expect(
    triggers.rows.some(
      (t) =>
        ['O', 'A'].includes(t.enabled) &&
        (t.event & 8) === 8 &&
        (t.event & 4) === 0 &&
        (t.event & 16) === 0 &&
        t.unconditional,
    ),
  ).toBe(true);
});

it('[AC-B1-19a#16] child tables retain account foreign keys and none of the union foreign keys cascade', async () => {
  for (const table of TABLES) {
    for (const fk of await foreignKeys(app, table)) {
      expect(['a', 'r'], `${table} ON DELETE`).toContain(fk.on_delete);
      expect(['a', 'r'], `${table} ON UPDATE`).toContain(fk.on_update);
    }
  }
  for (const table of ['union_credentials', 'union_pids'] as const) {
    const fk = await accountKey(app, table);
    const accountColumn = fk.columns.find((c) => c !== 'app_id' && c !== 'platform');
    expect(accountColumn).toBeDefined();
    expect(await sqlState(insertRow(app, table, { [accountColumn!]: randomUUID() }))).toBe('23503');
  }
});

it('[AC-B1-19a#17] grants provide union reads/writes without exposing writes to unrelated roles', async () => {
  for (const table of TABLES) {
    await columns(app, table);
    for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER']) {
        // Credential history can be append-only or mutable, at the implementer's choice.
        if (role === 'couli_app' && table === 'union_credentials' && privilege === 'UPDATE')
          continue;
        // Readonly credential access may be narrowed because it stores secrets.
        if (role === 'couli_readonly' && table === 'union_credentials' && privilege === 'SELECT')
          continue;
        const columnGrant = ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
          ? sql<boolean>`has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege})`
          : sql<boolean>`false`;
        const result = await sql<{ allowed: boolean }>`
          SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) OR ${columnGrant} AS allowed
        `.execute(app);
        const expected =
          (role === 'couli_app' && ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)) ||
          (role === 'couli_readonly' && privilege === 'SELECT');
        expect(result.rows[0]?.allowed, `${role} ${table} ${privilege}`).toBe(expected);
      }
    }
  }
});

it('[AC-B1-19a#18] pid CHECK domains contain exactly the statuses and contract scenes', async () => {
  await columns(app, 'union_pids');
  for (const [column, expected] of [
    ['status', ['pending', 'active', 'retired']],
    ['pid_scene', pidScenes()],
  ] as const) {
    const checks = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = to_regclass('app.union_pids') AND c.contype = 'c'
        AND cardinality(c.conkey) = 1 AND a.attname = ${column}
    `.execute(app);
    // HJY's multi-column CHECK must not supply the status domain's literals.
    const labels = checks.rows.flatMap(({ definition }) =>
      [...definition.matchAll(/'([^']*)'/g)].map((m) => m[1]!),
    );
    expect([...new Set(labels)].sort(), column).toEqual([...expected].sort());
  }
});

it('[AC-B1-19a#19] the union writer can persist renewal and probe results', async () => {
  const row = await insertRow(app, 'union_accounts', {
    app_id: `renewal-${randomUUID()}`,
    auth_renewed_by: null,
    auth_renewed_at: null,
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
  });
  expect(row).toMatchObject({ last_probe_at: null, last_probe_ok: null, last_probe_error: null });
  for (const ok of [false, true]) {
    const error = ok ? null : 'fixture-authorization-invalid';
    const status = ok ? 'active' : 'expired';
    expect(
      await sqlState(
        sql`
      UPDATE app.union_accounts
      SET auth_expires_at = ${EXPIRES}, auth_renewed_at = ${AT}, auth_renewed_by = NULL,
          auth_status = ${status}, alert_stage = ${ok ? 'none' : 'expired'},
          last_probe_at = ${AT}, last_probe_ok = ${ok}, last_probe_error = ${error}
      WHERE app_id = ${row['app_id']}
    `.execute(app),
      ),
    ).toBe('no error');
    const stored = await sql<Record<string, unknown>>`
      SELECT auth_expires_at, auth_renewed_at, auth_renewed_by, auth_status,
             last_probe_at, last_probe_ok, last_probe_error, sync_start_at
      FROM app.union_accounts WHERE app_id = ${row['app_id']}
    `.execute(app);
    expect(stored.rows).toEqual([
      {
        auth_expires_at: EXPIRES,
        auth_renewed_at: AT,
        auth_renewed_by: null,
        auth_status: status,
        last_probe_at: AT,
        last_probe_ok: ok,
        last_probe_error: error,
        sync_start_at: AT,
      },
    ]);
  }
});

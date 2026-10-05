// B1-02b: 04 §3.2 sessions / refresh_tokens, consent_records, devices; BR-ID-07 / BR-ID-12.
// The admin connection string is consumed only by the existing integration globalSetup; every
// query here uses a business role. Run outside the sandbox, before and after the migration.
// API refresh/grace/reuse detection and login_merge decisions belong to later API tests.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  checkedLiteral,
  columns,
  hex64,
  insertRow,
  newUser,
  primaryKeyColumns,
  sqlState,
  uniqueKeys,
  useDb,
} from './kit.ts';

const TABLES = ['sessions', 'refresh_tokens', 'consent_records'] as const;
const TEXT = ['text', 'varchar', 'bpchar'];
const HASH = [...TEXT, 'bytea'];
const INSTANT = ['timestamptz'];
const NOW = new Date('2026-10-05T00:00:00Z');
const EXPIRES = new Date('2026-11-04T00:00:00Z');
const DENIED = '42501';
let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

// Read only the simple mapping keys of these two contract enums; no new YAML dependency.
// Fail closed if the contract changes shape instead of running an empty positive-case loop.
function contractValues(name: 'consent_type' | 'consent_channel'): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/identity.yaml', import.meta.url),
    'utf8',
  );
  const block = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:|(?![\\s\\S]))`, 'm').exec(
    source,
  )?.[1];
  const values = [...(block ?? '').matchAll(/^      ([a-z_]+):/gm)].map((m) => m[1]!);
  if (values.length === 0) throw new Error(`Missing contract enum ${name}`);
  return values;
}

async function shape(table: string, name: string, types: readonly string[], nullable?: boolean) {
  const column = (await columns(table)).find((c) => c.name === name);
  expect(column, `${table}.${name}`).toBeDefined();
  const enumType = await sql<{ is_enum: boolean }>`
    SELECT t.typtype = 'e' AS is_enum FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attname = ${name}
  `.execute(app);
  // A database enum and constrained text both represent the contract's string value sets.
  const enumColumn = ['subject_type', 'type', 'channel'].includes(name);
  expect(
    types.includes(column?.type ?? '') || (enumColumn && enumType.rows[0]?.is_enum === true),
    `${table}.${name} type`,
  ).toBe(true);
  if (nullable !== undefined) expect(column?.nullable, `${table}.${name} nullable`).toBe(nullable);
}

async function hashValue(table: string, name: string, hex = hex64()) {
  return (await columns(table)).find((c) => c.name === name)?.type === 'bytea'
    ? Buffer.from(hex, 'hex')
    : hex;
}

async function newDevice(userId: string | null = null, values: Record<string, unknown> = {}) {
  const id = randomUUID();
  await insertRow('devices', {
    id,
    app_id: 'couli',
    user_id: userId,
    device_hash: hex64(),
    id_source: 'idfv',
    install_secret_cipher: Buffer.from('fixture-encrypted-install-secret'),
    ...values,
  });
  return id;
}

async function newSession(appId = 'couli', sid = randomUUID()) {
  const userId = await newUser({ app_id: appId });
  const deviceId = await newDevice(userId, { app_id: appId });
  await insertRow('sessions', {
    app_id: appId,
    sid,
    user_id: userId,
    device_id: deviceId,
    revoked_at: null,
    revoke_reason: null,
  });
  return { sid, userId, deviceId };
}

async function newConsent(values: Record<string, unknown> = {}) {
  const subject = values['subject_type'] ?? 'user';
  const userId = subject === 'device' ? null : await newUser();
  const deviceId = 'device_id' in values ? values['device_id'] : await newDevice(userId);
  return insertRow('consent_records', {
    app_id: 'couli',
    subject_type: subject,
    user_id: userId,
    device_id: deviceId,
    type: 'privacy',
    version: 1,
    channel: 'privacy_center',
    accepted: true,
    client_at: NOW,
    server_at: NOW,
    // 04 names the snapshot content but does not prescribe JSON key spellings.
    // Supply an opaque fixture; this task does not test the signing service's snapshot builder.
    text_sha256: await hashValue('consent_records', 'text_sha256'),
    signer_snapshot: JSON.stringify({
      platform_name: '测试主体',
      unified_social_credit_code: 'fixture-credit-code',
      realname_record_id: randomUUID(),
      masked_name: '测*',
    }),
    ...values,
  });
}

it('[AC-B1-02b#1] [04 §3.2 通则] session tables exist in app with app_id and created_at', async () => {
  for (const table of TABLES) {
    const relation = await sql<{ kind: string }>`
      SELECT c.relkind::text AS kind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ${table}
    `.execute(app);
    expect(relation.rows, table).toEqual([{ kind: 'r' }]);
    await shape(table, 'app_id', TEXT, false);
    await shape(table, 'created_at', INSTANT, false);
  }
});

it('[AC-B1-02b#2] [04 §3.2 sessions] session ownership and nullable revocation fields exist', async () => {
  await shape('sessions', 'id', ['uuid'], false);
  await shape('sessions', 'updated_at', INSTANT, false);
  expect(await primaryKeyColumns('sessions')).toEqual(['id']);
  await shape('sessions', 'sid', [...TEXT, 'uuid'], false);
  await shape('sessions', 'user_id', ['uuid'], false);
  await shape('sessions', 'device_id', ['uuid'], false);
  await shape('sessions', 'revoked_at', INSTANT, true);
  await shape('sessions', 'revoke_reason', TEXT, true);
});

it('[AC-B1-02b#3] [04 §3.2 refresh_tokens] [BR-ID-07] tokens have hashes and a nullable parent, never stored token values', async () => {
  await shape('refresh_tokens', 'id', ['uuid'], false);
  await shape('refresh_tokens', 'updated_at', INSTANT, false);
  expect(await primaryKeyColumns('refresh_tokens')).toEqual(['id']);
  await shape('refresh_tokens', 'sid', [...TEXT, 'uuid'], false);
  await shape('refresh_tokens', 'token_hash', HASH, false);
  await shape('refresh_tokens', 'parent_hash', HASH, true);
  await shape('refresh_tokens', 'rotated_at', INSTANT, true);
  await shape('refresh_tokens', 'expire_at', INSTANT, false);
  for (const table of ['sessions', 'refresh_tokens']) {
    const names = (await columns(table)).map((c) => c.name);
    expect(
      names.filter((name) => /token|jwt|secret|cipher|payload/i.test(name)),
      table,
    ).toEqual(table === 'refresh_tokens' ? ['token_hash'] : []);
  }
});

it('[AC-B1-02b#4] [04 §3.2 consent_records] consent facts, subject and signing evidence have suitable types', async () => {
  await shape('consent_records', 'subject_type', TEXT, false);
  await shape('consent_records', 'user_id', ['uuid'], true);
  // User records can also carry the originating device: do not impose an exclusive-or.
  await shape('consent_records', 'device_id', ['uuid'], true);
  for (const name of ['type', 'channel']) await shape('consent_records', name, TEXT, false);
  await shape('consent_records', 'version', ['int2', 'int4', 'int8'], false);
  await shape('consent_records', 'accepted', ['bool'], false);
  for (const name of ['client_at', 'server_at'])
    await shape('consent_records', name, INSTANT, false);
  // The excerpt does not prescribe nullability of the additional signing evidence.
  await shape('consent_records', 'text_sha256', HASH);
  await shape('consent_records', 'signer_snapshot', ['json', 'jsonb']);
});

it('[AC-B1-02b#5] [04 §3.2 devices] install_secret is a required bytea cipher, replacing the hash', async () => {
  await shape('devices', 'install_secret_cipher', ['bytea'], false);
  expect((await columns('devices')).map((c) => c.name)).not.toContain('install_secret_hash');
  const id = await newDevice();
  const stored = await sql<{ cipher: Buffer }>`
    SELECT install_secret_cipher AS cipher FROM app.devices WHERE id = ${id}
  `.execute(app);
  expect(stored.rows[0]?.cipher).toEqual(Buffer.from('fixture-encrypted-install-secret'));
  expect(await sqlState(newDevice(null, { install_secret_cipher: null }))).toBe('23502');
});

it('[AC-B1-02b#6] [BR-ID-07] a root and its direct successor retain their hash chain across rotation and sid revocation', async () => {
  await shape('sessions', 'sid', [...TEXT, 'uuid'], false);
  await shape('refresh_tokens', 'token_hash', HASH, false);
  await shape('devices', 'install_secret_cipher', ['bytea'], false);
  const { sid } = await newSession();
  const first = await hashValue('refresh_tokens', 'token_hash');
  const second = await hashValue('refresh_tokens', 'token_hash');
  const root = {
    app_id: 'couli',
    sid,
    token_hash: first,
    parent_hash: null,
    rotated_at: null,
    expire_at: EXPIRES,
  };
  await insertRow('refresh_tokens', root);
  expect(await sqlState(insertRow('refresh_tokens', root))).toBe('23505');
  expect(
    await sqlState(
      sql`
    UPDATE app.refresh_tokens SET rotated_at = ${NOW}
    WHERE app_id = 'couli' AND token_hash = ${first}
  `.execute(app),
    ),
  ).toBe('no error');
  await insertRow('refresh_tokens', { ...root, token_hash: second, parent_hash: first });
  const chain = await sql<{
    token_hash: unknown;
    parent_hash: unknown;
    rotated_at: Date | null;
    expire_at: Date;
  }>`
    SELECT token_hash, parent_hash, rotated_at, expire_at FROM app.refresh_tokens
    WHERE app_id = 'couli' AND sid = ${sid}
  `.execute(app);
  expect(chain.rows).toHaveLength(2);
  expect(chain.rows).toEqual(
    expect.arrayContaining([
      { token_hash: first, parent_hash: null, rotated_at: NOW, expire_at: EXPIRES },
      { token_hash: second, parent_hash: first, rotated_at: null, expire_at: EXPIRES },
    ]),
  );
  // Storage capability only: no claim that SQL itself implements API reuse detection.
  const reason = (await checkedLiteral('sessions', 'revoke_reason')) ?? 'fixture-revocation';
  expect(
    await sqlState(
      sql`
    UPDATE app.sessions SET revoked_at = ${NOW}, revoke_reason = ${reason}
    WHERE app_id = 'couli' AND sid = ${sid}
  `.execute(app),
    ),
  ).toBe('no error');
  const revoked = await sql<{ revoked_at: Date; revoke_reason: string }>`
    SELECT revoked_at, revoke_reason FROM app.sessions WHERE app_id = 'couli' AND sid = ${sid}
  `.execute(app);
  expect(revoked.rows).toEqual([{ revoked_at: NOW, revoke_reason: reason }]);
});

it('[AC-B1-02b#7] [BR-ID-12] both consent subjects and every contracted type can be inserted', async () => {
  for (const subject_type of ['user', 'device']) {
    expect(await sqlState(newConsent({ subject_type })), subject_type).toBe('no error');
  }
  for (const type of contractValues('consent_type')) {
    expect(
      await sqlState(
        newConsent({
          type,
          channel: type === 'labor_agreement' ? 'withdraw_flow' : 'privacy_center',
        }),
      ),
      type,
    ).toBe('no error');
  }
});

it('[AC-B1-02b#8] [BR-ID-12] every contracted consent channel including login_merge and withdraw_flow is accepted', async () => {
  for (const channel of contractValues('consent_channel')) {
    const type =
      channel === 'withdraw_flow'
        ? 'labor_agreement'
        : channel === 'agent_sheet'
          ? 'ai_third_party'
          : channel === 'realname_sheet'
            ? 'id_verification'
            : 'privacy';
    expect(await sqlState(newConsent({ channel, type })), channel).toBe('no error');
  }
});

it('[AC-B1-02b#9] [BR-ID-12] unknown subject, type and channel values are rejected by PostgreSQL', async () => {
  for (const [column, invalid] of [
    ['subject_type', ['account', 'USER', '']],
    ['type', ['marketing', 'PRIVACY', '']],
    ['channel', ['admin_console', 'LOGIN_MERGE', '']],
  ] as const) {
    for (const value of invalid) {
      expect(['23514', '22P02'], `${column}=${value}`).toContain(
        await sqlState(newConsent({ [column]: value })),
      );
    }
  }
});

it('[AC-B1-02b#13] [BR-ID-12] consent enum domains contain exactly the contract values', async () => {
  for (const [name, expected] of [
    ['subject_type', ['user', 'device']],
    ['type', contractValues('consent_type')],
    ['channel', contractValues('consent_channel')],
  ] as const) {
    const enums = await sql<{ label: string }>`
      SELECT e.enumlabel AS label FROM pg_attribute a
      JOIN pg_enum e ON e.enumtypid = a.atttypid
      WHERE a.attrelid = to_regclass('app.consent_records') AND a.attname = ${name}
    `.execute(app);
    const checks = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = to_regclass('app.consent_records') AND c.contype = 'c'
        AND cardinality(c.conkey) = 1 AND a.attname = ${name}
    `.execute(app);
    // Single-column lists only; coupled rules (e.g. labor_agreement requires a user)
    // must not contribute literals from other columns to the enum domain.
    const labels =
      enums.rows.length > 0
        ? enums.rows.map((r) => r.label)
        : checks.rows.flatMap(({ definition }) =>
            [...definition.matchAll(/'([^']*)'/g)].map((m) => m[1]!),
          );
    expect([...new Set(labels)].sort(), name).toEqual([...expected].sort());
  }
});

it('[AC-B1-02b#10] [BR-ID-12] consent history only appends, including refusals and repeated versions', async () => {
  await shape('consent_records', 'subject_type', TEXT, false);
  await shape('devices', 'install_secret_cipher', ['bytea'], false);
  const row = await newConsent();
  const later = new Date('2026-10-05T00:00:01Z');
  await newConsent({
    user_id: row['user_id'],
    device_id: row['device_id'],
    accepted: false,
    server_at: later,
  });
  const before = await sql<Record<string, unknown>>`
    SELECT * FROM app.consent_records WHERE user_id = ${row['user_id']} ORDER BY server_at
  `.execute(app);
  expect(before.rows).toHaveLength(2);
  expect(before.rows.map((r) => r['accepted'])).toEqual([true, false]);
  expect(
    await sqlState(
      sql`
    UPDATE app.consent_records SET accepted = false WHERE user_id = ${row['user_id']}
  `.execute(app),
    ),
  ).toBe(DENIED);
  expect(
    await sqlState(
      sql`
    DELETE FROM app.consent_records WHERE user_id = ${row['user_id']}
  `.execute(app),
    ),
  ).toBe(DENIED);
  const after = await sql<Record<string, unknown>>`
    SELECT * FROM app.consent_records WHERE user_id = ${row['user_id']} ORDER BY server_at
  `.execute(app);
  expect(after.rows).toEqual(before.rows);
});

it('[AC-B1-02b#11] [04 §3.2 consent_records] both subject lookup indexes end with type and server_at DESC', async () => {
  const indexes = await sql<{ keys: string[]; server_desc: boolean }>`
    SELECT ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
      FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS keys,
      (i.indoption[4] & 1) = 1 AS server_desc
    FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = 'consent_records'
      AND i.indisvalid AND i.indisready
  `.execute(app);
  for (const subjectId of ['user_id', 'device_id']) {
    expect(
      indexes.rows.some(
        ({ keys, server_desc }) =>
          ['app_id', 'subject_type', subjectId, 'type'].every((key, i) => keys[i] === key) &&
          /^server_at(?: DESC(?: NULLS (?:FIRST|LAST))?)?$/.test(keys[4] ?? '') &&
          server_desc,
      ),
      subjectId,
    ).toBe(true);
  }
});

it('[AC-B1-02b#12] [04 §3.2] [ADR-0001 §4.2#8] identity tables grant business access without granting consent rewrites', async () => {
  for (const table of [...TABLES, 'devices']) {
    expect(
      (await columns(table)).length,
      `${table} must exist before checking grants`,
    ).toBeGreaterThan(0);
  }
  for (const table of [...TABLES, 'devices']) {
    for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
      // Deleting session/token history is not required by the excerpt; do not require that grant.
      const privileges =
        role === 'couli_app' && table !== 'consent_records'
          ? ['SELECT', 'INSERT', 'UPDATE', 'TRUNCATE']
          : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
      for (const privilege of privileges) {
        const columnPrivilege = ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
          ? sql<boolean>`has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege})`
          : sql<boolean>`false`;
        const result = await sql<{ allowed: boolean }>`
          SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege})
            OR ${columnPrivilege} AS allowed
        `.execute(app);
        const expected =
          role === 'couli_readonly'
            ? privilege === 'SELECT'
            : role === 'couli_app' &&
              (privilege === 'SELECT' ||
                privilege === 'INSERT' ||
                (privilege === 'UPDATE' && table !== 'consent_records'));
        expect(result.rows[0]?.allowed, `${role} ${table} ${privilege}`).toBe(expected);
      }
    }
  }
});

it('[AC-B1-02b#14] [04 §3.2 通则] sid is unique within an app and can be reused by another app', async () => {
  expect(await uniqueKeys('sessions')).toContainEqual(['app_id', 'sid']);
  const sid = randomUUID();
  expect(await sqlState(newSession('couli', sid))).toBe('no error');
  // newSession supplies fresh entity ids: the rejection must concern sid, not the primary key.
  expect(await sqlState(newSession('couli', sid))).toBe('23505');
  expect(await sqlState(newSession('couli_two', sid))).toBe('no error');
});

it('[AC-B1-02b#15] [04 §3.2 通则] [BR-ID-07] token_hash is unique within an app and can be reused by another app', async () => {
  expect(await uniqueKeys('refresh_tokens')).toContainEqual(['app_id', 'token_hash']);
  await shape('sessions', 'sid', [...TEXT, 'uuid'], false);
  await shape('devices', 'install_secret_cipher', ['bytea'], false);
  const first = await newSession();
  const sameApp = await newSession();
  const otherApp = await newSession('couli_two');
  const token = {
    app_id: 'couli',
    sid: first.sid,
    token_hash: await hashValue('refresh_tokens', 'token_hash'),
    parent_hash: null,
    rotated_at: null,
    expire_at: EXPIRES,
  };
  expect(await sqlState(insertRow('refresh_tokens', token))).toBe('no error');
  // Different session and entity ids cannot bypass app-wide hash uniqueness.
  expect(await sqlState(insertRow('refresh_tokens', { ...token, sid: sameApp.sid }))).toBe('23505');
  expect(
    await sqlState(
      insertRow('refresh_tokens', { ...token, app_id: 'couli_two', sid: otherApp.sid }),
    ),
  ).toBe('no error');
});

it('[AC-B1-02b#16] [04 §3.2 consent_records] [BR-ID-32] h5_landing user consent can be recorded without a device', async () => {
  await shape('consent_records', 'device_id', ['uuid'], true);
  expect(
    await sqlState(newConsent({ subject_type: 'user', channel: 'h5_landing', device_id: null })),
  ).toBe('no error');
});

it('[AC-B1-02b#17] [04 §3.2 consent_records] [BR-ID-13] device consent can carry an associated user_id', async () => {
  await shape('consent_records', 'user_id', ['uuid'], true);
  await shape('devices', 'install_secret_cipher', ['bytea'], false);
  const userId = await newUser();
  const deviceId = await newDevice(userId);
  expect(
    await sqlState(newConsent({ subject_type: 'device', user_id: userId, device_id: deviceId })),
  ).toBe('no error');
});

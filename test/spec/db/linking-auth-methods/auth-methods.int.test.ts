// B1-06r: BR-ID-17 authorization metadata at issuance, per the task's storage scope.
// Catalog checks precede every DML probe: the pre-migration database fails assertions.
// No migration filename, API credential exchange, or configuration lookup is prescribed here.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  EXPIRES,
  RELEASED,
  columns,
  connect,
  insertRow,
  newUser,
  requireTable,
  sqlState,
} from '../linking-bindings/kit.ts';

const TABLE = 'union_auth_sessions';
const METADATA = ['client', 'auth_methods', 'auth_app_refs'];
const WEB_REFS = { web_code: 'app-ref-web-1' };
const BOTH_REFS = { ...WEB_REFS, sdk_token: 'app-ref-sdk-1' };
const USED = new Date('2026-10-06T00:01:00Z');
const LATER = new Date('2026-10-06T00:02:00Z');
let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

function contractValues(file: string, name: string): string[] {
  const source = readFileSync(
    new URL(`../../../../contracts/enums/${file}`, import.meta.url),
    'utf8',
  );
  const block = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:|$(?![\\s\\S]))`, 'm').exec(
    source,
  )?.[1];
  const values = [...(block ?? '').matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map(
    (match) => match[1]!,
  );
  expect(values.length, `${file}: ${name} must be readable`).toBeGreaterThan(0);
  return values;
}

async function requireMetadata(): Promise<void> {
  await requireTable(TABLE);
  expect((await columns(TABLE)).map((column) => column.name)).toEqual(
    expect.arrayContaining(METADATA),
  );
}

async function newSession(values: Record<string, unknown> = {}): Promise<string> {
  const appId = String(values['app_id'] ?? 'couli');
  const userId = await newUser({ app_id: appId });
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: appId,
    user_id: userId,
    platform: ['ios', 'android', 'harmony'].includes(String(values['client']))
      ? values['client']
      : 'ios',
    install_secret_cipher: Buffer.from('fixture-ciphertext'),
  });
  const state = randomUUID();
  const row = {
    state,
    app_id: appId,
    user_id: userId,
    device_id: deviceId,
    platform: 'taobao',
    mode: 'bind',
    link_id: null,
    expire_at: EXPIRES,
    used_at: null,
    created_at: RELEASED,
    client: 'ios',
    auth_methods: ['web_code'],
    auth_app_refs: JSON.stringify(WEB_REFS),
    ...values,
  };
  // Keep issuance metadata explicit instead of letting catalog-driven fixtures supply it.
  await sql`INSERT INTO app.union_auth_sessions (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(app);
  return state;
}

async function acceptedSession(values: Record<string, unknown> = {}): Promise<string> {
  let state = '';
  expect(
    await sqlState(
      newSession(values).then((value) => {
        state = value;
      }),
    ),
    'valid authorization metadata can be inserted',
  ).toBe('no error');
  return state;
}

async function stored(state: string) {
  const result = await sql<{
    client: string;
    auth_methods: string[] | null;
    auth_app_refs: Record<string, string> | null;
    used_at: Date | null;
  }>`SELECT client, auth_methods, auth_app_refs, used_at
    FROM app.union_auth_sessions WHERE state = ${state}`.execute(app);
  return result.rows;
}

it('[AC-B1-06r#1] issuance metadata has the required types and nullability', async () => {
  await requireMetadata();
  const shape = (await columns(TABLE)).filter((column) => METADATA.includes(column.name));
  expect(shape.map(({ name, type, nullable }) => ({ name, type, nullable }))).toEqual(
    expect.arrayContaining([
      { name: 'client', type: 'text', nullable: false },
      { name: 'auth_methods', type: '_text', nullable: true },
      { name: 'auth_app_refs', type: 'jsonb', nullable: true },
    ]),
  );
});

it('[AC-B1-06r#2] all contract platforms accept the three specified native device clients', async () => {
  await requireMetadata();
  const clients = contractValues('platform.yaml', 'client_platform');
  // These are the three native clients explicitly listed by the task, not the entire enum.
  for (const client of ['ios', 'android', 'harmony']) {
    expect(clients).toContain(client);
    for (const platform of contractValues('platform.yaml', 'platform')) {
      const state = await acceptedSession({
        client,
        platform,
        ...(platform !== 'taobao' ? { auth_methods: null, auth_app_refs: null } : {}),
      });
      expect((await stored(state))[0]?.client).toBe(client);
    }
  }
});

it('[AC-B1-06r#3] client is mandatory and unknown or incorrectly cased clients fail CHECK on every platform', async () => {
  await requireMetadata();
  for (const platform of contractValues('platform.yaml', 'platform')) {
    const values = {
      platform,
      ...(platform !== 'taobao' ? { auth_methods: null, auth_app_refs: null } : {}),
    };
    expect(await sqlState(newSession({ ...values, client: null }))).toBe('23502');
    for (const client of ['', 'unknown_client', 'IOS', ' android ']) {
      expect(await sqlState(newSession({ ...values, client })), client).toBe('23514');
    }
  }
});

it('[AC-B1-06r#4] each issued method and both orders of the list round-trip with their application references', async () => {
  await requireMetadata();
  const methods = contractValues('identity.yaml', 'auth_method');
  expect(methods).toEqual(['web_code', 'sdk_token']);
  for (const issued of [...methods.map((method) => [method]), methods, [...methods].reverse()]) {
    const refs = Object.fromEntries(issued.map((method) => [method, `app-ref-${method}-1`]));
    const state = await acceptedSession({
      auth_methods: issued,
      auth_app_refs: JSON.stringify(refs),
    });
    expect(await stored(state)).toEqual([
      { client: 'ios', auth_methods: issued, auth_app_refs: refs, used_at: null },
    ]);
  }
});

it('[AC-B1-06r#5] Taobao requires a nonempty issued list with only distinct contract methods', async () => {
  await requireMetadata();
  for (const auth_methods of [null, [], ['not_a_method'], ['WEB_CODE'], ['']]) {
    const refs =
      auth_methods === null
        ? null
        : JSON.stringify(Object.fromEntries(auth_methods.map((method) => [method, 'app-ref-1'])));
    expect(
      await sqlState(newSession({ auth_methods, auth_app_refs: refs })),
      JSON.stringify(auth_methods),
    ).toBe('23514');
  }
  for (const method of contractValues('identity.yaml', 'auth_method')) {
    for (const auth_methods of [
      [method, method],
      [method, 'not_a_method'],
      [method, null],
      [null],
    ]) {
      const refs = JSON.stringify(
        Object.fromEntries(
          auth_methods.filter((entry) => entry !== null).map((entry) => [entry, 'app-ref-1']),
        ),
      );
      expect(
        await sqlState(newSession({ auth_methods, auth_app_refs: refs })),
        JSON.stringify(auth_methods),
      ).toBe('23514');
    }
  }
  expect(
    await sqlState(
      newSession({
        auth_methods: ['web_code', 'sdk_token', 'web_code'],
        auth_app_refs: JSON.stringify(BOTH_REFS),
      }),
    ),
  ).toBe('23514');
  expect(await sqlState(newSession({ auth_methods: null, auth_app_refs: null }))).toBe('23514');
});

it('[AC-B1-06r#6] Pinduoduo stores SQL NULL for both method fields and rejects an issued list', async () => {
  await requireMetadata();
  const state = await acceptedSession({ platform: 'pdd', auth_methods: null, auth_app_refs: null });
  expect(await stored(state)).toEqual([
    { client: 'ios', auth_methods: null, auth_app_refs: null, used_at: null },
  ]);
  for (const auth_methods of [[], ['web_code'], ['sdk_token'], ['web_code', 'sdk_token']]) {
    expect(await sqlState(newSession({ platform: 'pdd', auth_methods, auth_app_refs: null }))).toBe(
      '23514',
    );
  }
  expect(await sqlState(newSession({ platform: 'pdd' }))).toBe('23514');
});

it('[AC-B1-06r#7] Taobao references must have exactly the issued method keys, irrespective of key order', async () => {
  await requireMetadata();
  for (const [auth_methods, refs] of [
    [['web_code'], {}],
    [['web_code'], { sdk_token: 'app-ref-sdk-1' }],
    [['web_code'], BOTH_REFS],
    [['web_code', 'sdk_token'], WEB_REFS],
    [['web_code'], { ...WEB_REFS, extra_method: 'app-ref-extra-1' }],
  ] as const) {
    expect(
      await sqlState(
        newSession({ auth_methods: [...auth_methods], auth_app_refs: JSON.stringify(refs) }),
      ),
      JSON.stringify({ auth_methods, refs }),
    ).toBe('23514');
  }
  const state = await acceptedSession({
    auth_methods: ['web_code', 'sdk_token'],
    auth_app_refs: JSON.stringify({ sdk_token: 'app-ref-sdk-1', ...WEB_REFS }),
  });
  expect((await stored(state))[0]?.auth_app_refs).toEqual(BOTH_REFS);
});

it('[AC-B1-06r#8] Taobao references are a non-null object of identifiers, not nested configuration or scalar JSON', async () => {
  await requireMetadata();
  for (const auth_app_refs of [
    null,
    'null',
    JSON.stringify([]),
    JSON.stringify('app-ref-web-1'),
    JSON.stringify({ web_code: null }),
    JSON.stringify({ web_code: { app_ref: 'app-ref-web-1' } }),
    JSON.stringify({ web_code: ['app-ref-web-1'] }),
  ]) {
    expect(await sqlState(newSession({ auth_app_refs })), String(auth_app_refs)).toBe('23514');
  }
});

it('[AC-B1-06r#9] Pinduoduo rejects any non-SQL-NULL application references even with no issued methods', async () => {
  await requireMetadata();
  for (const auth_app_refs of ['null', '{}', JSON.stringify(WEB_REFS)]) {
    expect(
      await sqlState(newSession({ platform: 'pdd', auth_methods: null, auth_app_refs })),
      auth_app_refs,
    ).toBe('23514');
  }
});

it('[AC-B1-06r#10] couli_app cannot update any issuance column before or after consumption', async () => {
  await requireMetadata();
  for (const platform of ['taobao', 'pdd']) {
    const state = await acceptedSession({
      platform,
      ...(platform === 'pdd' ? { auth_methods: null, auth_app_refs: null } : {}),
    });
    for (const consumed of [false, true]) {
      if (consumed) {
        expect(
          await sqlState(
            sql`UPDATE app.union_auth_sessions SET used_at = ${USED}
          WHERE state = ${state}`.execute(app),
          ),
        ).toBe('no error');
      }
      const original = await stored(state);
      for (const change of [
        sql`client = 'android'`,
        sql`auth_methods = ARRAY['sdk_token']::text[]`,
        sql`auth_app_refs = ${JSON.stringify({ web_code: 'app-ref-web-2' })}::jsonb`,
        sql`client = NULL`,
        sql`auth_methods = NULL`,
        sql`auth_app_refs = NULL`,
      ]) {
        expect(
          await sqlState(
            sql`UPDATE app.union_auth_sessions SET ${change}
          WHERE state = ${state}`.execute(app),
          ),
        ).toBe('42501');
        expect(await stored(state)).toEqual(original);
      }
    }
  }
});

// TODO(规划/11 §4.3): Probe metadata rewrites as a role with UPDATE permission
// — blocked on the trusted test harness exposing such a role; business roles cannot grant it.
// The used_at probe below exercises the real trigger, but cannot prove its metadata branch.
it('[AC-B1-06r#11] used_at remains writable once and cannot be cleared or changed; metadata stays intact', async () => {
  await requireMetadata();
  for (const platform of ['taobao', 'pdd']) {
    const state = await acceptedSession({
      platform,
      ...(platform === 'pdd' ? { auth_methods: null, auth_app_refs: null } : {}),
    });
    const original = (await stored(state))[0]!;
    expect(
      await sqlState(
        sql`UPDATE app.union_auth_sessions SET used_at = ${USED}
      WHERE state = ${state}`.execute(app),
      ),
    ).toBe('no error');
    expect(await stored(state)).toEqual([{ ...original, used_at: USED }]);
    for (const used_at of [null, LATER]) {
      expect(
        await sqlState(
          sql`UPDATE app.union_auth_sessions SET used_at = ${used_at}
        WHERE state = ${state}`.execute(app),
        ),
      ).toBe('23001');
      expect(await stored(state)).toEqual([{ ...original, used_at: USED }]);
    }
  }
});

it('[AC-B1-06r#12] grants retain only used_at UPDATE and preserve access for all other business roles', async () => {
  await requireMetadata();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const column of await columns(TABLE)) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const result = await sql<{ allowed: boolean }>`SELECT
          has_column_privilege(${role}, 'app.union_auth_sessions', ${column.name}, ${privilege}) AS allowed
        `.execute(app);
        const expected =
          role === 'couli_app'
            ? privilege === 'SELECT' ||
              privilege === 'INSERT' ||
              (privilege === 'UPDATE' && column.name === 'used_at')
            : role === 'couli_readonly' && privilege === 'SELECT';
        expect(result.rows[0]?.allowed, `${role} ${column.name} ${privilege}`).toBe(expected);
      }
    }
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const result = await sql<{ allowed: boolean }>`SELECT
        has_table_privilege(${role}, 'app.union_auth_sessions', ${privilege}) AS allowed
      `.execute(app);
      expect(result.rows[0]?.allowed, `${role} ${privilege}`).toBe(false);
    }
  }
  const state = await acceptedSession();
  const original = await stored(state);
  expect(
    await sqlState(sql`DELETE FROM app.union_auth_sessions WHERE state = ${state}`.execute(app)),
  ).toBe('42501');
  expect(await stored(state)).toEqual(original);
});

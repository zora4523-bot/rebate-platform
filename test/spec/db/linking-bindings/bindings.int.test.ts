// B1-06b storage rules only: task excerpt 04 §3.2, BR-ID-17 / BR-ID-19,
// ADD-01 and db/AGENTS.md. No API 30104/30151, clock/config policy or attribution tests.
// In particular released rows do NOT occupy the partial unique indexes during cooldown:
// checking cooldown against the injected Clock is explicitly the application's job.
// Catalog assertions precede DML so missing tables (including dependency B1-19a's
// union_accounts) produce AssertionError, not PostgreSQL undefined_table errors.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  BOUND,
  COOLDOWN,
  EXPIRES,
  RELEASED,
  columns,
  connect,
  foreignKeys,
  newAccount,
  newAuth,
  newBinding,
  newLink,
  newUser,
  requireTable,
  shape,
  sqlState,
  uniqueKeys,
} from './kit.ts';

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

function bindingStatuses(): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/identity.yaml', import.meta.url),
    'utf8',
  );
  const block = /^  union_binding_status:\n([\s\S]*?)(?=^  \w+:)/m.exec(source)?.[1];
  const values = [...(block ?? '').matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!);
  expect(values.length, 'contract enum must be readable').toBeGreaterThan(0);
  return values;
}

it('[AC-B1-06b#1] binding columns preserve external IDs as text and nullable lifecycle timestamps', async () => {
  await requireTable('union_bindings');
  await requireTable('union_accounts');
  await shape('union_bindings', 'app_id', 'text', false);
  await shape('union_bindings', 'user_id', 'uuid', false);
  await shape('union_bindings', 'union_account_id', undefined, false);
  await shape('union_bindings', 'platform', 'text', false);
  await shape('union_bindings', 'status', undefined, false);
  for (const name of ['relation_id', 'special_id', 'pdd_custom', 'blocked_reason', 'reason']) {
    await shape('union_bindings', name, 'text');
  }
  for (const name of ['bound_at', 'released_at', 'cooldown_until']) {
    await shape('union_bindings', name, 'timestamptz', true);
  }
  expect((await columns('union_bindings')).map((c) => c.name)).not.toContain('activated_at');
});

it('[AC-B1-06b#2] binding status accepts the contract values and rejects obsolete cooling or unknown values', async () => {
  await requireTable('union_bindings');
  for (const status of bindingStatuses()) {
    expect(await sqlState(newBinding({ status })), status).toBe('no error');
  }
  for (const status of ['cooling', 'rebind', 'ACTIVE', 'not_a_status', '']) {
    expect(['23514', '22P02'], status).toContain(await sqlState(newBinding({ status })));
  }
});

it('[AC-B1-06b#3] relation ownership is unique for every pair of active, invalid and blocked states', async () => {
  for (const firstStatus of ['active', 'invalid', 'blocked']) {
    for (const secondStatus of ['active', 'invalid', 'blocked']) {
      const first = await newBinding({ status: firstStatus });
      expect(
        await sqlState(
          newBinding({
            union_account_id: first['union_account_id'],
            relation_id: first['relation_id'],
            status: secondStatus,
          }),
        ),
        `${firstStatus} / ${secondStatus}, different users`,
      ).toBe('23505');
    }
  }
});

it('[AC-B1-06b#4] user uniqueness also includes pending_auth and is independent of account and relation', async () => {
  for (const firstStatus of ['pending_auth', 'active', 'invalid', 'blocked']) {
    for (const secondStatus of ['pending_auth', 'active', 'invalid', 'blocked']) {
      const first = await newBinding({ status: firstStatus });
      expect(
        await sqlState(newBinding({ user_id: first['user_id'], status: secondStatus })),
        `${firstStatus} / ${secondStatus}, different accounts and relations`,
      ).toBe('23505');
    }
  }
});

it('[AC-B1-06b#5] unbound and released history does not occupy either unique key; pending_auth does not reserve a relation', async () => {
  for (const status of ['unbound', 'released']) {
    const old = await newBinding({ status });
    const same = {
      user_id: old['user_id'],
      union_account_id: old['union_account_id'],
      relation_id: old['relation_id'],
    };
    expect(await sqlState(newBinding({ ...same, status }))).toBe('no error');
    expect(await sqlState(newBinding(same))).toBe('no error');
  }
  const pending = await newBinding({ status: 'pending_auth' });
  expect(
    await sqlState(
      newBinding({
        union_account_id: pending['union_account_id'],
        relation_id: pending['relation_id'],
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-06b#6] binding unique keys include exactly the specified tenant, platform and account scope', async () => {
  await requireTable('union_bindings');
  const keys = await uniqueKeys('union_bindings');
  expect(keys).toContainEqual(['app_id', 'union_account_id', 'platform', 'relation_id'].sort());
  expect(keys).toContainEqual(['app_id', 'user_id', 'platform'].sort());
  const first = await newBinding();
  expect(await sqlState(newBinding({ relation_id: first['relation_id'] }))).toBe('no error');
  expect(
    await sqlState(
      newBinding({
        user_id: first['user_id'],
        platform: 'jd',
        relation_id: first['relation_id'],
      }),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      newBinding({
        app_id: 'couli_two',
        relation_id: first['relation_id'],
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-06b#7] updates into occupied states cannot bypass either partial unique index', async () => {
  const owner = await newBinding();
  const pending = await newBinding({
    status: 'pending_auth',
    union_account_id: owner['union_account_id'],
    relation_id: owner['relation_id'],
  });
  expect(
    await sqlState(
      sql`
    UPDATE app.union_bindings SET status = 'active', bound_at = ${BOUND}
    WHERE app_id = 'couli' AND user_id = ${pending['user_id']} AND status = 'pending_auth'
  `.execute(app),
    ),
  ).toBe('23505');
  const history = await newBinding({ user_id: owner['user_id'], status: 'released' });
  expect(
    await sqlState(
      sql`
    UPDATE app.union_bindings SET status = 'active', released_at = NULL, cooldown_until = NULL
    WHERE app_id = 'couli' AND user_id = ${owner['user_id']}
      AND relation_id = ${history['relation_id']} AND status = 'released'
  `.execute(app),
    ),
  ).toBe('23505');
});

it('[AC-B1-06b#8] release and same-user restoration preserve the original bound_at on the existing row', async () => {
  const row = await newBinding();
  expect(
    await sqlState(
      sql`
    UPDATE app.union_bindings SET status = 'released', released_at = ${RELEASED}, cooldown_until = ${COOLDOWN}
    WHERE app_id = 'couli' AND user_id = ${row['user_id']}
  `.execute(app),
    ),
  ).toBe('no error');
  const released = await sql<{ bound_at: Date; released_at: Date; cooldown_until: Date }>`
    SELECT bound_at, released_at, cooldown_until FROM app.union_bindings
    WHERE app_id = 'couli' AND user_id = ${row['user_id']}
  `.execute(app);
  expect(released.rows).toEqual([
    { bound_at: BOUND, released_at: RELEASED, cooldown_until: COOLDOWN },
  ]);
  expect(
    await sqlState(
      sql`
    UPDATE app.union_bindings SET status = 'active', released_at = NULL, cooldown_until = NULL
    WHERE app_id = 'couli' AND user_id = ${row['user_id']} AND status = 'released'
  `.execute(app),
    ),
  ).toBe('no error');
  const restored = await sql<{
    status: string;
    bound_at: Date;
    released_at: null;
    cooldown_until: null;
  }>`
    SELECT status, bound_at, released_at, cooldown_until FROM app.union_bindings
    WHERE app_id = 'couli' AND user_id = ${row['user_id']}
  `.execute(app);
  expect(restored.rows).toEqual([
    { status: 'active', bound_at: BOUND, released_at: null, cooldown_until: null },
  ]);
});

it('[AC-B1-06b#9] released rows require both release instants and cannot end cooldown before release', async () => {
  for (const values of [
    { released_at: null },
    { cooldown_until: null },
    { cooldown_until: BOUND },
  ]) {
    expect(await sqlState(newBinding({ status: 'released', ...values }))).toBe('23514');
  }
  // Duration comes from configuration, not a hard-coded thirty-day SQL expression.
  expect(
    await sqlState(
      newBinding({
        status: 'released',
        cooldown_until: new Date('2026-12-05T00:00:00Z'),
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-06b#10] concurrent relation claims have one winner at the PostgreSQL unique constraint', async () => {
  await requireTable('union_bindings');
  const union_account_id = await newAccount();
  const relation_id = randomUUID().replace(/-/g, '');
  const results = await Promise.all([
    sqlState(newBinding({ union_account_id, relation_id })),
    sqlState(newBinding({ union_account_id, relation_id })),
  ]);
  expect(results.sort()).toEqual(['23505', 'no error']);
});

it('[AC-B1-06b#11] auth state has tenant/user/device scope, nullable link and consumption instant, and expiry', async () => {
  await requireTable('union_auth_sessions');
  for (const name of ['app_id', 'platform', 'mode']) {
    await shape('union_auth_sessions', name, 'text', false);
  }
  // state is an opaque server-generated identifier; 04 does not prescribe its encoding.
  await shape('union_auth_sessions', 'state', undefined, false);
  expect(['text', 'uuid']).toContain(
    (await columns('union_auth_sessions')).find((c) => c.name === 'state')?.type,
  );
  for (const name of ['user_id', 'device_id'])
    await shape('union_auth_sessions', name, 'uuid', false);
  await shape('union_auth_sessions', 'link_id', 'uuid', true);
  await shape('union_auth_sessions', 'expire_at', 'timestamptz', false);
  await shape('union_auth_sessions', 'used_at', 'timestamptz', true);
  expect(await sqlState(newAuth())).toBe('no error');
  expect(await sqlState(newAuth({ link_id: await newLink() }))).toBe('no error');
});

it('[AC-B1-06b#12] state is globally unique even across apps and after consumption or expiry', async () => {
  const row = await newAuth();
  expect(await sqlState(newAuth({ state: row['state'] }))).toBe('23505');
  expect(await sqlState(newAuth({ app_id: 'couli_two', state: row['state'] }))).toBe('23505');
  await sql`UPDATE app.union_auth_sessions SET used_at = ${RELEASED} WHERE state = ${row['state']}`.execute(
    app,
  );
  expect(await sqlState(newAuth({ state: row['state'] }))).toBe('23505');
  const expired = await newAuth({
    created_at: new Date('2020-01-01T00:00:00Z'),
    expire_at: new Date('2020-01-01T00:10:00Z'),
  });
  expect(await sqlState(newAuth({ state: expired['state'] }))).toBe('23505');
});

it('[AC-B1-06b#13] mode permits bind and CHECK rejects rebind, arbitrary values and NULL', async () => {
  expect(await sqlState(newAuth({ mode: 'bind' }))).toBe('no error');
  for (const mode of ['rebind', 'unbind', 'BIND', '']) {
    expect(await sqlState(newAuth({ mode })), mode).toBe('23514');
  }
  expect(await sqlState(newAuth({ mode: null }))).toBe('23502');
});

it('[AC-B1-06b#14] storage supports atomic single consumption and an exclusive expiry boundary', async () => {
  const row = await newAuth();
  // This is a storage-capability probe, not an implementation of the bindings API:
  // validity, credentials and identity must be checked by linking before this CAS.
  const consume = (state: unknown, now: Date) =>
    sql<{ state: string }>`
    UPDATE app.union_auth_sessions SET used_at = ${now}
    WHERE app_id = 'couli' AND state = ${state} AND used_at IS NULL AND expire_at > ${now}
    RETURNING state
  `.execute(app);
  const results = await Promise.all([
    consume(row['state'], RELEASED),
    consume(row['state'], RELEASED),
  ]);
  expect(results.map((r) => r.rows.length).sort()).toEqual([0, 1]);
  expect((await consume(row['state'], RELEASED)).rows).toEqual([]);
  const atBoundary = await newAuth();
  expect((await consume(atBoundary['state'], EXPIRES)).rows).toEqual([]);
  const stored = await sql<{ used_at: Date | null }>`
    SELECT used_at FROM app.union_auth_sessions WHERE state = ${atBoundary['state']}
  `.execute(app);
  expect(stored.rows).toEqual([{ used_at: null }]);
});

it('[AC-B1-06b#15] foreign keys retain users/accounts and never cascade update or delete', async () => {
  for (const table of ['union_bindings', 'union_auth_sessions']) {
    await requireTable(table);
    const keys = await foreignKeys(table);
    expect(
      keys.some(
        (k) =>
          k.target === 'users' &&
          k.source.join(',') === 'app_id,user_id' &&
          k.referenced.join(',') === 'app_id,id',
      ),
      table,
    ).toBe(true);
    if (table === 'union_bindings') {
      expect(
        keys.some((k) => k.target === 'union_accounts' && k.source.includes('union_account_id')),
      ).toBe(true);
    } else {
      for (const [target, column, referenced] of [
        ['devices', 'device_id', 'id'],
        ['links', 'link_id', 'link_id'],
      ]) {
        expect(
          keys.some(
            (k) =>
              k.target === target &&
              k.source.join(',') === `app_id,${column}` &&
              k.referenced.join(',') === `app_id,${referenced}`,
          ),
          target,
        ).toBe(true);
      }
    }
    for (const key of keys) {
      expect(key.validated).toBe(true);
      expect(['a', 'r'], `${table} ${key.target} ON DELETE`).toContain(key.on_delete);
      expect(['a', 'r'], `${table} ${key.target} ON UPDATE`).toContain(key.on_update);
    }
  }
  expect(await sqlState(newBinding({ user_id: randomUUID() }))).toBe('23503');
  expect(await sqlState(newAuth({ user_id: randomUUID() }))).toBe('23503');
  const other = await newUser({ app_id: 'couli_two' });
  expect(await sqlState(newBinding({ user_id: other }))).toBe('23503');
  expect(await sqlState(newAuth({ user_id: other }))).toBe('23503');
  expect(await sqlState(newAuth({ device_id: randomUUID() }))).toBe('23503');
  expect(await sqlState(newAuth({ link_id: randomUUID() }))).toBe('23503');
  const otherAuth = await newAuth({ app_id: 'couli_two' });
  expect(await sqlState(newAuth({ device_id: otherAuth['device_id'] }))).toBe('23503');
  const otherLink = await newLink({ app_id: 'couli_two' });
  expect(await sqlState(newAuth({ link_id: otherLink }))).toBe('23503');
});

it('[AC-B1-06b#16] linking tables reject NULL app_id and grant only the required business access', async () => {
  await requireTable('union_bindings');
  await requireTable('union_auth_sessions');
  expect(await sqlState(newBinding({ app_id: null }))).toBe('23502');
  expect(await sqlState(newAuth({ app_id: null }))).toBe('23502');
  for (const table of ['union_bindings', 'union_auth_sessions']) {
    for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const columnPrivilege = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)
          ? sql<boolean>`has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege})`
          : sql<boolean>`false`;
        const result = await sql<{ allowed: boolean }>`
          SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) OR ${columnPrivilege} AS allowed
        `.execute(app);
        const expected =
          role === 'couli_app'
            ? ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
            : role === 'couli_readonly' && privilege === 'SELECT';
        expect(result.rows[0]?.allowed, `${role} ${table} ${privilege}`).toBe(expected);
      }
    }
  }
});

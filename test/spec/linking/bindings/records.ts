import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { ACCOUNT_NAME, RELATION, type Fixture } from './kit.ts';
import { client, type Client } from './client.ts';

export async function account(f: Fixture, c: Client, platform = 'taobao', authStatus = 'active') {
  const row = await f.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: c.appId,
      platform,
      account_name: ACCOUNT_NAME,
      status: 'active',
      auth_status: authStatus,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}
export async function scenario(f: Fixture) {
  const c = await client(f);
  const accountId = await account(f, c);
  return { c, accountId };
}
export async function configure(
  f: Fixture,
  c: Client,
  methods: string[],
  deviceClient = c.deviceClient,
) {
  await f.db
    .insertInto('config_items')
    .values({
      app_id: c.appId,
      key: `union.taobao.auth_methods.${deviceClient}`,
      value: JSON.stringify(methods),
      updated_by: 'synthetic',
    })
    .execute();
}
export async function state(
  f: Fixture,
  c: Client,
  overrides: Partial<Insertable<DB['union_auth_sessions']>> = {},
) {
  const methods = overrides.auth_methods ?? ['web_code'];
  const refs = Object.fromEntries(
    (methods as string[]).map((method) => [method, `synthetic/issued-app/${method}`]),
  );
  return f.db
    .insertInto('union_auth_sessions')
    .values({
      state: `synthetic-state-${randomUUID()}`,
      app_id: c.appId,
      user_id: c.uid,
      device_id: c.deviceId,
      platform: 'taobao',
      mode: 'bind',
      link_id: null,
      client: c.deviceClient,
      expire_at: new Date(f.clock.now().getTime() + 600_000),
      created_at: f.clock.now(),
      used_at: null,
      auth_methods: methods,
      auth_app_refs: sql<
        DB['union_auth_sessions']['auth_app_refs']
      >`${JSON.stringify(refs)}::jsonb`,
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function binding(
  f: Fixture,
  c: Client,
  accountId: string,
  overrides: Partial<Insertable<DB['union_bindings']>> = {},
) {
  const status = overrides.status ?? 'active';
  return f.db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: c.appId,
      user_id: c.uid,
      platform: 'taobao',
      union_account_id: accountId,
      relation_id: RELATION,
      status,
      bound_at: new Date(f.clock.now().getTime() - 86_400_000),
      released_at: status === 'released' ? new Date(f.clock.now().getTime() - 60_000) : null,
      cooldown_until: status === 'released' ? new Date(f.clock.now().getTime() + 60_000) : null,
      blocked_reason: status === 'blocked' ? 'admin_disable' : null,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export function bindings(f: Fixture, c: Client) {
  return f.db
    .selectFrom('union_bindings')
    .selectAll()
    .where('app_id', '=', c.appId)
    .orderBy('id')
    .execute();
}
export function states(f: Fixture, c: Client) {
  return f.db
    .selectFrom('union_auth_sessions')
    .selectAll()
    .where('app_id', '=', c.appId)
    .orderBy('state')
    .execute();
}
export async function snapshot(f: Fixture, c: Client) {
  return { states: await states(f, c), bindings: await bindings(f, c) };
}

// B1-06b fixtures: reuse the frozen, catalog-driven B1-06a insert helper.
// Unknown dependency columns are filled from the catalog; business expectations below
// remain explicit. Missing tables fail assertions before any DML or regclass cast.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { columns, insertRow, newUser, useDb } from '../linking/kit.ts';

export { columns, insertRow, newLink, newUser, sqlState } from '../linking/kit.ts';

export const BOUND = new Date('2026-10-01T00:00:00Z');
export const RELEASED = new Date('2026-10-06T00:00:00Z');
export const COOLDOWN = new Date('2026-11-05T00:00:00Z');
export const EXPIRES = new Date('2026-10-06T00:10:00Z');
let app: Kysely<DB>;

export function connect(db: Kysely<DB>): void {
  app = db;
  useDb(db);
}

export async function requireTable(table: string): Promise<void> {
  const result = await sql<{ kind: string }>`
    SELECT c.relkind::text AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
  `.execute(app);
  expect(result.rows, `app.${table} must exist as an ordinary table`).toEqual([{ kind: 'r' }]);
}

export async function shape(table: string, name: string, type?: string, nullable?: boolean) {
  const column = (await columns(table)).find((c) => c.name === name);
  expect(column, `${table}.${name}`).toBeDefined();
  if (type !== undefined) expect(column?.type, `${table}.${name} type`).toBe(type);
  if (nullable !== undefined) expect(column?.nullable, `${table}.${name} nullable`).toBe(nullable);
}

export async function foreignKeys(table: string) {
  const result = await sql<{
    target: string;
    source: string[];
    referenced: string[];
    on_delete: string;
    on_update: string;
    validated: boolean;
  }>`
    SELECT ft.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS source,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.ord) AS referenced,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update,
      c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN pg_namespace fn ON fn.oid = ft.relnamespace
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'
      AND fn.nspname = 'app'
  `.execute(app);
  return result.rows;
}

export async function newAccount(appId = 'couli', platform = 'taobao'): Promise<unknown> {
  await requireTable('union_accounts');
  const fk = (await foreignKeys('union_bindings')).find(
    (key) => key.target === 'union_accounts' && key.source.includes('union_account_id'),
  );
  expect(fk, 'union_bindings.union_account_id references union_accounts').toBeDefined();
  const key = fk!.referenced[fk!.source.indexOf('union_account_id')];
  expect(key).toBeDefined();
  const row = await insertRow('union_accounts', { app_id: appId, platform });
  expect(row[key!], 'account fixture supplies its referenced key').toBeDefined();
  return row[key!];
}

export async function newBinding(values: Record<string, unknown> = {}) {
  await requireTable('union_bindings');
  const appId = String(values['app_id'] ?? 'couli');
  const platform = String(values['platform'] ?? 'taobao');
  const status = String(values['status'] ?? 'active');
  return insertRow('union_bindings', {
    app_id: appId,
    user_id: values['user_id'] ?? (await newUser({ app_id: appId })),
    platform,
    union_account_id: values['union_account_id'] ?? (await newAccount(appId, platform)),
    relation_id: randomUUID().replace(/-/g, ''),
    status,
    bound_at: ['unbound', 'pending_auth'].includes(status) ? null : BOUND,
    released_at: status === 'released' ? RELEASED : null,
    cooldown_until: status === 'released' ? COOLDOWN : null,
    blocked_reason: status === 'blocked' ? 'ban' : null,
    ...values,
  });
}

export async function newAuth(values: Record<string, unknown> = {}) {
  await requireTable('union_auth_sessions');
  const appId = String(values['app_id'] ?? 'couli');
  const userId = await newUser({ app_id: appId });
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: appId,
    user_id: userId,
    install_secret_cipher: Buffer.from('fixture-ciphertext'),
  });
  return insertRow('union_auth_sessions', {
    app_id: appId,
    state: randomUUID(),
    user_id: userId,
    device_id: deviceId,
    platform: 'taobao',
    mode: 'bind',
    link_id: null,
    expire_at: EXPIRES,
    used_at: null,
    created_at: RELEASED,
    ...(await issuanceDefaults(String(values['platform'] ?? 'taobao'))),
    ...values,
  });
}

/**
 * B1-06s: synthetic issuance metadata for the columns B1-06r adds to union_auth_sessions
 * (client; Taobao auth_methods with matching auth_app_refs; other platforms leave both NULL).
 * Only columns that exist are filled, so rows are identical to the pre-B1-06r shape before
 * that migration; callers' values still override every default.
 */
async function issuanceDefaults(platform: string): Promise<Record<string, unknown>> {
  const present = new Set((await columns('union_auth_sessions')).map((c) => c.name));
  const out: Record<string, unknown> = {};
  if (present.has('client')) out['client'] = 'ios';
  if (platform === 'taobao' && present.has('auth_methods')) out['auth_methods'] = ['web_code'];
  if (platform === 'taobao' && present.has('auth_app_refs')) {
    out['auth_app_refs'] = JSON.stringify({ web_code: 'fixture-app-ref' });
  }
  return out;
}

export async function uniqueKeys(table: string): Promise<string[][]> {
  const result = await sql<{ keys: string[] }>`
    SELECT ARRAY(SELECT a.attname::text
      FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys
    FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})
      AND i.indisunique AND i.indisvalid AND i.indisready
  `.execute(app);
  return result.rows.map((row) => row.keys.sort());
}

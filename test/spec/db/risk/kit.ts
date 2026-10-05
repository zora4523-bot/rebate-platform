// B1-03a: local copy of the identity/notification catalog-fixture approach.
// No generated risk types exist yet. All queries use the business connection and raw SQL.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLES = [
  'blocklist',
  'user_risk_state',
  'appeals',
  'risk_rules',
  'risk_hits',
] as const;
export type Table = (typeof TABLES)[number];
export const NOW = new Date('2026-10-05T02:00:00Z');
export const BLOCKLIST_EXPIRES_AT = new Date('2028-10-05T02:00:00Z');
export const DEADLINE = new Date('2026-10-08T16:00:00Z');
export const ACTIONS = ['pass', 'manual_review', 'block', 'void_commission'];
export const CHECK_ERRORS = ['23514', '23502', '22P02'];

let app: Kysely<DB>;
export function useDb(db: Kysely<DB>): void {
  app = db;
}

export type Column = {
  name: string;
  type: string;
  category: string;
  nullable: boolean;
  hasDefault: boolean;
};

export async function columns(table: string): Promise<Column[]> {
  const result = await sql<Column>`
    SELECT a.attname AS name, t.typname AS type, t.typcategory::text AS category,
           NOT a.attnotnull AS nullable,
           (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS "hasDefault"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'app' AND c.relname = ${table} AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(app);
  return result.rows;
}

const REQUIRED: Record<Table, string[]> = {
  blocklist: [
    'id',
    'dimension',
    'value_hmac',
    'violation_type',
    'reason',
    'created_by',
    'expire_at',
    'platform',
    'union_account_id',
    'start_at',
    'end_at',
    'status',
    'updated_at',
  ],
  user_risk_state: [
    'user_id',
    'state',
    'reason',
    'reason_category',
    'frozen_until',
    'changed_by',
    'changed_at',
    'updated_at',
  ],
  appeals: [
    'id',
    'user_id',
    'target_type',
    'request_type',
    'target_id',
    'prev_risk_state',
    'status',
    'content',
    'deadline_at',
    'handler_id',
    'closed_at',
    'updated_at',
  ],
  risk_rules: ['id', 'rule_id', 'scene', 'risk_action', 'status', 'version', 'updated_at'],
  risk_hits: [
    'user_id',
    'rule_id',
    'risk_action',
    'ref_type',
    'ref_id',
    'request_type',
    'amount_fen',
  ],
};

/** Assert before constructing fixtures: missing migrations must fail as assertions, not SQL errors. */
export async function ready(...tables: Table[]): Promise<void> {
  for (const table of tables) {
    const list = await columns(table);
    expect(list.length, `missing app.${table}: apply the B1-03a migration`).toBeGreaterThan(0);
    expect(
      list.map((c) => c.name),
      `required columns of app.${table}`,
    ).toEqual(expect.arrayContaining(['app_id', 'created_at', ...REQUIRED[table]]));
    if (table === 'appeals' || table === 'risk_hits') await phoneColumn(table);
    if (table === 'risk_hits') {
      await phoneColumn(table, 'masked');
      await hitColumn('dimension');
      await hitColumn('hmac');
    }
    if (table === 'risk_rules') await conditionColumn();
  }
}

/** Names not frozen by CT-02d are discovered, but their semantic columns must exist. */
async function semanticColumn(table: string, names: string[], pattern: RegExp): Promise<string> {
  const list = await columns(table);
  const exact = names.find((name) => list.some((c) => c.name === name));
  if (exact) return exact;
  const matches = list.filter((c) => pattern.test(c.name));
  expect(matches.length, `${table}: expected one column for ${pattern.source}`).toBe(1);
  return matches[0]!.name;
}

export async function phoneColumn(
  table: string,
  kind: 'hmac' | 'masked' = 'hmac',
): Promise<string> {
  return semanticColumn(
    table,
    [`phone_${kind}`, `related_phone_${kind}`, `associated_phone_${kind}`],
    kind === 'hmac' ? /phone.*hmac|hmac.*phone/ : /phone.*mask|mask.*phone/,
  );
}

export async function hitColumn(kind: 'dimension' | 'hmac'): Promise<string> {
  return semanticColumn(
    'risk_hits',
    kind === 'dimension' ? ['dimension', 'hit_dimension'] : ['value_hmac', 'hit_value_hmac'],
    kind === 'dimension' ? /dimension/ : /^(?!.*phone).*value.*hmac/,
  );
}

export async function conditionColumn(): Promise<string> {
  const columnsList = await columns('risk_rules');
  const named = ['conditions', 'condition', 'condition_json'].find((name) =>
    columnsList.some((c) => c.name === name),
  );
  if (named) return named;
  const list = columnsList.filter((c) => ['json', 'jsonb'].includes(c.type));
  expect(list.length, 'risk_rules needs a JSON conditions column').toBe(1);
  return list[0]!.name;
}

export function contractValues(name: string): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/identity.yaml', import.meta.url),
    'utf8',
  );
  const block = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_]*:|$(?![\\s\\S]))`,
    'm',
  ).exec(source)?.[1];
  expect(block, `contract enum ${name}`).toBeDefined();
  const values = [...(block ?? '').matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!);
  expect(values.length, name).toBeGreaterThan(0);
  return values;
}

/** Ignore cross-column CHECKs: literals there belong to multiple different value sets. */
export async function allowedValues(table: string, name: string): Promise<string[]> {
  const checks = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'app' AND r.relname = ${table} AND c.contype = 'c'
      AND cardinality(c.conkey) = 1 AND a.attname = ${name}
  `.execute(app);
  const enums = await sql<{ label: string }>`
    SELECT e.enumlabel AS label FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_enum e ON e.enumtypid = a.atttypid
    WHERE n.nspname = 'app' AND r.relname = ${table} AND a.attname = ${name}
  `.execute(app);
  return [
    ...new Set([
      ...checks.rows.flatMap(({ def }) => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]!)),
      ...enums.rows.map((r) => r.label),
    ]),
  ].sort();
}

export async function primaryKey(table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT a.attname AS name FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = k.num
    WHERE n.nspname = 'app' AND r.relname = ${table} AND c.contype = 'p'
    ORDER BY k.ord
  `.execute(app);
  return result.rows.map((r) => r.name);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

export function hex64(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

async function filler(table: string, col: Column): Promise<unknown> {
  // Copy the existing kit's composite-FK support for untested fixture columns (actors, users).
  const refs = await sql<{ target: string; name: string }>`
    SELECT ft.relname AS target, fa.attname AS name FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) k(src, dst)
    JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = k.src
    JOIN pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = k.dst
    WHERE n.nspname = 'app' AND r.relname = ${table} AND c.contype = 'f'
      AND a.attname = ${col.name} AND a.attname <> 'app_id'
  `.execute(app);
  const ref = refs.rows[0];
  if (ref) return (await insertRow(ref.target, { app_id: 'couli' }))[ref.name];
  const literal = (await allowedValues(table, col.name))[0];
  if (literal !== undefined) return literal;
  if (col.name.endsWith('_hmac')) return hmacValue(table, col.name);
  if (col.name === 'device_hash') return hex64();
  switch (col.type) {
    case 'uuid':
      return randomUUID();
    case 'int8':
      return 1n;
    case 'int2':
    case 'int4':
    case 'numeric':
      return 1;
    case 'bool':
      return false;
    case 'timestamp':
    case 'timestamptz':
      return NOW;
    case 'date':
      return '2026-10-05';
    case 'json':
    case 'jsonb':
      return '{}';
    case 'bytea':
      return Buffer.from(hex64(), 'hex');
    default:
      return randomUUID();
  }
}

export async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = { ...values };
  for (const col of await columns(table)) {
    if (col.name in row || col.nullable || col.hasDefault) continue;
    row[col.name] = await filler(table, col);
  }
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *
  `.execute(app);
  return result.rows[0]!;
}

/** Fill a nullable fixture field explicitly when the scenario (e.g. closure) needs it. */
export async function fixtureValue(table: string, name: string): Promise<unknown> {
  const col = (await columns(table)).find((c) => c.name === name);
  expect(col, `${table}.${name}`).toBeDefined();
  return filler(table, col!);
}

export async function hmacValue(
  table: string,
  name: string,
  value = hex64(),
): Promise<string | Buffer> {
  const col = (await columns(table)).find((c) => c.name === name);
  expect(col, `${table}.${name}`).toBeDefined();
  return col?.type === 'bytea' ? Buffer.from(value, 'hex') : value;
}

export async function newUser(): Promise<string> {
  expect((await columns('users')).map((c) => c.name)).toEqual(
    expect.arrayContaining(['id', 'app_id']),
  );
  const id = randomUUID();
  await insertRow('users', { id, app_id: 'couli' });
  return id;
}

export async function appealRow(
  target: string,
  request: string | null = null,
): Promise<Record<string, unknown>> {
  const user = request === 'register' ? null : await newUser();
  return {
    id: randomUUID(),
    app_id: 'couli',
    user_id: user,
    target_type: target,
    target_id: target === 'account' ? user : randomUUID(),
    request_type: request,
    prev_risk_state: target === 'account' ? 'banned' : null,
    status: 'processing',
    content: '用户请求复核',
    deadline_at: DEADLINE,
    handler_id: null,
    closed_at: null,
    [await phoneColumn('appeals')]:
      target === 'blocked_request'
        ? await hmacValue('appeals', await phoneColumn('appeals'))
        : null,
  };
}

export async function hitRow(request = 'register'): Promise<Record<string, unknown>> {
  const dimension = await hitColumn('dimension');
  const dimensions = await allowedValues('risk_hits', dimension);
  const refTypes = await allowedValues('risk_hits', 'ref_type');
  // These encodings are not fixed by the contract; prefer the matching catalog literals.
  const phoneDimension = dimensions.find((v) => /phone/.test(v)) ?? dimensions[0] ?? 'phone';
  const blockedRef =
    refTypes.length === 0
      ? 'blocked_request'
      : (refTypes.find((v) => v === 'blocked_request') ??
        refTypes.find((v) => /blocked?_?req/.test(v)));
  expect(blockedRef, '需要「被拦截的请求」取值 [04 §3.2 risk_hits]').toBeDefined();
  return {
    app_id: 'couli',
    // insertRow fills rule_id through its actual FK (id or rule_id), as in the existing kit.
    risk_action: 'block',
    user_id: request === 'register' ? null : await newUser(),
    ref_type: blockedRef,
    ref_id: randomUUID(),
    request_type: request,
    [dimension]: phoneDimension,
    [await hitColumn('hmac')]: await hmacValue('risk_hits', await hitColumn('hmac')),
    [await phoneColumn('risk_hits')]: await hmacValue('risk_hits', await phoneColumn('risk_hits')),
    [await phoneColumn('risk_hits', 'masked')]: '138****0000',
    amount_fen: request === 'withdraw' ? 12345n : null,
  };
}

export async function hasPrivilege(
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege})
      OR CASE WHEN ${privilege} IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        THEN has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege})
        ELSE false END AS ok
  `.execute(app);
  return result.rows[0]?.ok === true;
}

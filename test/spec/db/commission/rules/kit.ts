// B2-01d storage fixtures. BR-CALC-02/05/06/07/11/17; no publication service here.
// Platform choice: FK to the existing app.platforms(code) dictionary (contract values).
// SQL skeletons are rejected by tools/guard/lib/skeleton.ts; table assertions produce red.
// Cross-level maxima, coverage and indirect_enabled × rates belong to B2-03f publication.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLES = [
  'commission_rule_versions',
  'commission_rules',
  'commission_rule_reserves',
] as const;
export const VERSION = TABLES[0];
export const RULE = TABLES[1];
export const RESERVE = TABLES[2];
export const TIMEOUT = 60_000;
export const EFFECTIVE = new Date('2032-01-01T00:00:00+08:00');
export const PUBLISHED = new Date('2031-12-01T00:00:00+08:00');
export const UPDATE_COLUMNS = [
  'status',
  'publisher_id',
  'published_at',
  'revoked_at',
  'indirect_approver_id',
  'indirect_approved_at',
];
export type Row = Record<string, unknown>;

export interface Harness {
  database: TestDatabase;
  app: Kysely<DB>;
  readonly: Kysely<DB>;
}

export async function open(): Promise<Harness> {
  const database = await createTestDatabase();
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.app), destroyDb(h.readonly)]);
  await h.database.drop();
}

export async function columns(db: Kysely<DB>, table: string) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: string;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable AS nullable
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY ordinal_position`.execute(db)
  ).rows;
}

// Run inside every test, not beforeAll: absent migrations must fail an assertion per case.
export async function requireTables(db: Kysely<DB>): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ kind: string }>`SELECT c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ${table}`.execute(db);
    expect(result.rows, `B2-01d must create app.${table}`).toEqual([{ kind: 'r' }]);
  }
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Do not turn syntax, missing relations or programmer errors into expected rejections.
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code)) {
      throw error;
    }
    return code;
  }
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function admin(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'admin_users', {
    id,
    app_id: appId,
    login_name: `fixture-${id}`,
    password_hash: 'synthetic-not-a-password',
    is_super: false,
    status: 'active',
  });
  return id;
}

export async function versionRow(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  const appId = String(values['app_id'] ?? `b201d-${randomUUID()}`);
  const actor = await admin(db, appId);
  return {
    rule_version_id: randomUUID(),
    app_id: appId,
    status: 'draft',
    effective_from: EFFECTIVE,
    drafter_id: actor,
    publisher_id: actor,
    published_at: PUBLISHED,
    ...values,
  };
}

export async function version(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  const row = await versionRow(db, values);
  expect(await sqlState(insert(db, VERSION, row)), 'valid version fixture').toBe('ok');
  return row;
}

export function ruleRow(parent: Row, values: Row = {}): Row {
  return {
    app_id: parent['app_id'],
    rule_version_id: parent['rule_version_id'],
    platform: 'taobao',
    level: 'L1',
    order_type: 'self',
    r_own_bp: 5000,
    r_direct_bp: 1000,
    r_indirect_bp: 0,
    ...values,
  };
}

export function reserveRow(parent: Row, values: Row = {}): Row {
  return {
    app_id: parent['app_id'],
    rule_version_id: parent['rule_version_id'],
    platform: 'taobao',
    reserve_bp: 0,
    ...values,
  };
}

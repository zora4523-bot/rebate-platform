// B2-04b：仅测试迁移存储；不实现快照计算、差错单命令或状态迁移。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

export type Row = Record<string, unknown>;
export const TABLES = ['recon_diffs', 'asset_snapshots', 'asset_snapshot_receivables'] as const;
export const AT = '2032-07-01T00:01:00+08:00';
export const TOTALS = [
  'total_available_positive_fen',
  'total_negative_fen',
  'total_frozen_fen',
  'total_waiting_fen',
  'total_estimated_fen',
] as const;

interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function harness(createTestDatabase: () => Promise<Database>) {
  let database: Database | undefined;
  let app: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  }, 60_000);
  afterAll(async () => {
    if (app) await destroyDb(app);
    if (database) await database.drop();
  }, 60_000);
  return {
    get app() {
      return app;
    },
  };
}

// 每条测试体内调用：缺迁移必须由断言先红，不能由 42P01 / 缺文件先红。
export async function ready(db: Kysely<DB>): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ present: boolean }>`
      SELECT to_regclass(${`app.${table}`}) IS NOT NULL AS present
    `.execute(db);
    expect(result.rows, `missing app.${table}`).toEqual([{ present: true }]);
  }
}

export function migrationSource(): string {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter((name) =>
    /^\d{4}_settlement-ledger-owned\.sql$/.test(name),
  );
  expect(names, '按后缀定位，不预留迁移编号').toHaveLength(1);
  return readFileSync(new URL(names[0]!, directory), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}

export function recon(values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `recon-${randomUUID()}`,
    type: 'ledger_mismatch',
    source: 'R3',
    period: '2032-06-30',
    ref_type: 'account',
    ref_id: randomUUID(),
    expected_fen: 100n,
    actual_fen: 99n,
    diff_fen: 1n,
    status: 'open',
    handler_id: null,
    closed_at: null,
    dedupe_key: null,
    resolution: null,
    created_at: AT,
    updated_at: AT,
    ...values,
  };
}

// S15：快照合计放主表，各平台应收以 bigint 分存入子表。
export function snapshot(values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `snapshot-${randomUUID()}`,
    snapshot_date: '2032-06-30',
    total_available_positive_fen: 9007199254740993n,
    total_negative_fen: 400n,
    total_frozen_fen: 100n,
    total_waiting_fen: 925n,
    total_estimated_fen: 123n,
    waiting_comparable: true,
    created_at: AT,
    updated_at: AT,
    ...values,
  };
}

export function receivable(parent: Row, values: Row = {}): Row {
  return {
    asset_snapshot_id: parent['id'],
    app_id: parent['app_id'],
    platform: 'taobao',
    union_receivable_fen: 9007199254740993n,
    ...values,
  };
}

export async function columns(db: Kysely<DB>, table: string) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; expression: string | null }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS expression FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
  `.execute(db)
  ).rows;
}

export async function indexes(db: Kysely<DB>, table: string) {
  return (
    await sql<{
      name: string;
      keys: string[];
      unique: boolean;
      valid: boolean;
      predicate: string | null;
      constraint_backed: boolean;
    }>`SELECT c.relname AS name, i.indisunique AS unique, i.indisvalid AND i.indisready AS valid,
    pg_get_expr(i.indpred, i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.pos <= i.indnkeyatts ORDER BY k.pos) AS keys,
    EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u'))
      AS constraint_backed
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(${`app.${table}`})
  `.execute(db)
  ).rows;
}

export async function seedHandler(db: Kysely<DB>, appId: unknown): Promise<string> {
  const id = randomUUID();
  await insert(db, 'admin_users', {
    id,
    app_id: appId,
    login_name: `handler-${id}`,
    password_hash: 'test-only',
    is_super: false,
    status: 'active',
  });
  return id;
}

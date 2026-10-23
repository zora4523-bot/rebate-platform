// BR-AI-22 / B3-09f §9: SQL fixtures; no implementation or generated-type changes.
// createTestDatabase is passed in by *.int.test.ts; this kit has no runtime testing import.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const TABLES = [
  'agent_messages',
  'agent_tool_calls',
  'agent_cards',
  'agent_runs',
  'agent_result_sets',
  'agent_result_deliveries',
  'agent_result_chains',
] as const;
export type Table = (typeof TABLES)[number];
export type Row = Record<string, unknown>;
type Role = 'couli_app' | 'couli_readonly' | 'couli_payout' | 'couli_maint';
interface DatabaseHandle {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: DatabaseHandle;
  app: Kysely<DB>;
  readonly: Kysely<DB>;
  payout: Kysely<DB>;
  maint: Kysely<DB>;
}
export const AT = new FixedClock('2026-10-22T08:00:00.000Z').now();
export const HASH = '0123456789abcdef'.repeat(4);
export const OTHER_HASH = 'fedcba9876543210'.repeat(4);
export const MEMBER_ID = '019a0000-0000-7000-8000-000000000123';
export const MEMBER = JSON.stringify(['member', MEMBER_ID]);
export const HASHED_MEMBER = JSON.stringify(['member', HASH]);
export const GUEST = [
  JSON.stringify(['device', 'synthetic-device']),
  JSON.stringify(['ip', '192.0.2.1']),
];
export const OK = 'no error';
export const DENIED = '42501';
export const REWRITE = '23001';

export const NEW_UPDATES: Partial<Record<Table, string[]>> = {
  agent_tool_calls: ['args'],
  agent_cards: ['data', 'fallback_text'],
  agent_runs: ['quota_subjects'],
  agent_result_sets: ['conditions'],
  agent_result_deliveries: ['card'],
  agent_result_chains: ['conditions'],
};

export function open(database: DatabaseHandle): Harness {
  const connection = (role: Role) => createDb({ connectionString: database.urlFor(role), max: 1 });
  return {
    database,
    app: connection('couli_app'),
    readonly: connection('couli_readonly'),
    payout: connection('couli_payout'),
    maint: connection('couli_maint'),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([h.app, h.readonly, h.payout, h.maint].map((db) => destroyDb(db)));
  await h.database.drop();
}

// Each test asserts the new column-grant contract before DML (including regressions).
// The baseline therefore fails with AssertionError, not raw permission/fixture errors.
// No migration name, implementation symbol or source-text matching is used.
export async function ready(db: Kysely<DB>): Promise<void> {
  for (const [table, names] of Object.entries(NEW_UPDATES)) {
    for (const name of names) {
      const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
        'couli_app', ${`app.${table}`}, ${name}, 'UPDATE') AS allowed`.execute(db);
      expect(result.rows, `BR-AI-22 new UPDATE(${name}) on ${table}`).toEqual([{ allowed: true }]);
    }
  }
}

export async function sqlState(query: Promise<unknown>): Promise<string> {
  try {
    await query;
    return OK;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

export function insertStatement(table: string, row: Row) {
  const names = Object.keys(row);
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`;
}

async function insert(db: Kysely<DB>, table: string, row: Row): Promise<Row> {
  const result = await insertStatement(table, row).execute(db);
  expect(result.rows, `fixture insert ${table}`).toHaveLength(1);
  return result.rows[0]!;
}

export function update(db: Kysely<DB>, table: Table, row: Row, values: Row) {
  return sql<Row>`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE app_id = ${row['app_id']} RETURNING *`.execute(db);
}

export async function read(db: Kysely<DB>, table: Table, row: Row): Promise<Row> {
  const result = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
    WHERE app_id = ${row['app_id']}`.execute(db);
  expect(result.rows, `${table}: retained row skeleton`).toHaveLength(1);
  return result.rows[0]!;
}

export async function changed(
  db: Kysely<DB>,
  table: Table,
  row: Row,
  values: Row,
  expected: Row,
): Promise<Row> {
  const before = await read(db, table, row);
  expect(await sqlState(update(db, table, row, values)), `${table}: permitted purge`).toBe(OK);
  const after = await read(db, table, row);
  // Full-row equality checks every unmodified column, including timestamps and ownership.
  expect(after).toEqual({ ...before, ...expected });
  return after;
}

export async function rejected(
  db: Kysely<DB>,
  table: Table,
  row: Row,
  values: Row,
  code = REWRITE,
): Promise<void> {
  const before = await read(db, table, row);
  expect(await sqlState(update(db, table, row, values)), `${table}: forbidden rewrite`).toBe(code);
  expect(await read(db, table, row)).toEqual(before);
}

// Contract agent-stream.schema.json $defs/error: msg and fallback_q are text;
// type/code/retryable/fallback are structural facts, not redactable text.
export function errorFrame() {
  return {
    type: 'error',
    data: {
      code: 50302,
      msg: 'synthetic generated response',
      retryable: true,
      fallback: 'search_page',
      fallback_q: 'synthetic private query',
    },
  };
}

export async function fixture(db: Kysely<DB>, table: Table, overrides: Row = {}): Promise<Row> {
  await ready(db);
  // Unique app_id makes SELECT/UPDATE identify exactly one target, including composite PKs.
  const appId = `synthetic-purge-${randomUUID()}`;
  const deviceId = randomUUID();
  await insert(db, 'devices', {
    id: deviceId,
    app_id: appId,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-purge-secret'),
    device_hash: deviceId.replaceAll('-', '').repeat(2),
    id_source: 'idfv',
    platform: 'ios',
    app_version: 'synthetic@1',
    last_seen_at: AT,
  });
  const sessionId = randomUUID();
  await insert(db, 'agent_sessions', {
    id: sessionId,
    app_id: appId,
    user_id: null,
    device_id: deviceId,
    started_at: AT,
    last_active_at: AT,
  });
  const runId = randomUUID();
  const run = await insert(db, 'agent_runs', {
    id: runId,
    app_id: appId,
    session_id: sessionId,
    accepted_at: AT,
    prompt_version: 'synthetic-purge@1',
    quota_subjects: [MEMBER],
    user_text: 'synthetic private question',
    ...(table === 'agent_runs' ? overrides : {}),
  });
  if (table === 'agent_runs') return run;
  const common = { app_id: appId, created_at: AT };
  if (table === 'agent_messages') {
    return insert(db, table, {
      ...common,
      id: randomUUID(),
      session_id: sessionId,
      run_id: runId,
      role: 'assistant',
      text: 'synthetic private answer',
      reported: true,
      reported_at: AT,
      report_status: 'pending',
      report_reason: 'synthetic private report',
      report_note: 'synthetic private note',
      ...overrides,
    });
  }
  if (table === 'agent_tool_calls') {
    return insert(db, table, {
      ...common,
      id: randomUUID(),
      run_id: runId,
      seq: 1,
      name: 'synthetic_search',
      args: '{"q":"synthetic private query"}',
      result_digest: 'synthetic digest',
      status: 'ok',
      latency_ms: 1,
      ...overrides,
    });
  }
  if (table === 'agent_cards') {
    return insert(db, table, {
      ...common,
      id: randomUUID(),
      session_id: sessionId,
      run_id: runId,
      card_id: 'c1',
      type: 'notice',
      schema_version: 1,
      data: '{"text":"synthetic private card"}',
      fallback_text: 'synthetic private fallback',
      ...overrides,
    });
  }
  if (table === 'agent_result_chains') {
    return insert(db, table, {
      ...common,
      session_id: sessionId,
      seq: 1,
      chain_id: 'synthetic-chain',
      status: 'has_products',
      conditions: '{"chain_id":"synthetic-chain","q":"synthetic private query"}',
      ...overrides,
    });
  }
  const set = await insert(db, 'agent_result_sets', {
    ...common,
    id: randomUUID(),
    run_id: runId,
    conditions: '{"q":"synthetic private query"}',
    ...(table === 'agent_result_sets' ? overrides : {}),
  });
  if (table === 'agent_result_sets') return set;
  return insert(db, table, {
    ...common,
    session_id: sessionId,
    run_id: runId,
    result_set_id: set['id'],
    position: 1,
    card_id: 'c1',
    product_key: 'jd:synthetic-product',
    platform: 'jd',
    final_price_fen: 12345n,
    card: '{"title":"synthetic private card","url":"https://example.invalid/product"}',
    ...overrides,
  });
}

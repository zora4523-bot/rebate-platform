// Scope: B1-04a's narrowed ledger notes, 04 §3.2, 02 §6.1 and ADR-0001 §4.2.
// Retention deletion and application-side request redaction belong to later tasks.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { partitionsOf, sqlState } from '../partitions/kit.ts';
import {
  REQUIRED,
  TABLE,
  TIMEOUT,
  columns,
  fixture,
  insert,
  requireColumns,
  requireTable,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

it('[AC-B1-04a#1] raw payload columns preserve compressed bytes and call metadata', async () => {
  await requireTable(app);
  const shape = (await columns(app)).map(({ name, type, nullable }) => ({ name, type, nullable }));
  expect(shape).toEqual(
    expect.arrayContaining([
      { name: 'id', type: 'int8', nullable: false },
      { name: 'app_id', type: 'text', nullable: false },
      { name: 'platform', type: 'text', nullable: false },
      { name: 'kind', type: 'text', nullable: false },
      { name: 'payload', type: 'bytea', nullable: false },
      { name: 'fetched_at', type: 'timestamptz', nullable: false },
      { name: 'content_hash', type: 'text', nullable: false },
      { name: 'request_summary', type: 'jsonb', nullable: false },
      { name: 'latency_ms', type: 'int4', nullable: false },
      { name: 'error_code', type: 'text', nullable: true },
    ]),
  );
});

it('[AC-B1-04a#2] RANGE(fetched_at) uses a primary key containing id and fetched_at', async () => {
  await requireTable(app);
  const partition = await sql<{ kind: string; key: string }>`
    SELECT c.relkind::text AS kind, pg_get_partkeydef(c.oid) AS key
    FROM pg_class c WHERE c.oid = to_regclass('app.union_raw_payloads')
  `.execute(app);
  expect(partition.rows).toEqual([{ kind: 'p', key: 'RANGE (fetched_at)' }]);
  const primary = await sql<{ names: string[] }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
      ORDER BY k.ord
    ) AS names FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.union_raw_payloads') AND c.contype = 'p'
  `.execute(app);
  expect(primary.rows).toHaveLength(1);
  expect(primary.rows[0]?.names).toEqual(expect.arrayContaining(['id', 'fetched_at']));
});

it('[AC-B1-04a#3] migrations create only a DEFAULT partition, with no calendar partitions', async () => {
  await requireTable(app);
  const partitions = await partitionsOf(app, TABLE);
  expect(partitions.map(({ bound }) => bound)).toEqual(['DEFAULT']);
  expect(partitions[0]?.name).not.toMatch(/_p\d{6}$/);
});

it(
  '[AC-B1-04a#4] required metadata rejects explicit NULL and repeated primary keys are rejected',
  async () => {
    await requireColumns(app);
    const row = fixture();
    expect(await sqlState(insert(app, row))).toBe('ok');
    // Omit generated id for ordinary inserts; explicitly NULL probes its NOT NULL constraint.
    // OVERRIDING SYSTEM VALUE also supports GENERATED ALWAYS identity implementations.
    for (const column of REQUIRED) {
      const bad = { ...row, [column]: null };
      expect(
        await sqlState(
          sql`INSERT INTO app.union_raw_payloads
            (${sql.join(Object.keys(bad).map((name) => sql.ref(name)))})
            OVERRIDING SYSTEM VALUE VALUES (${sql.join(Object.values(bad))})`.execute(app),
        ),
        column,
      ).toBe('23502');
    }
    expect(
      await sqlState(
        sql`INSERT INTO app.union_raw_payloads OVERRIDING SYSTEM VALUE
          SELECT * FROM app.union_raw_payloads LIMIT 1`.execute(app),
      ),
    ).toBe('23505');
  },
  TIMEOUT,
);

it('[AC-B1-04a#5] defaults never generate UUIDv7 or read SQL clocks outside created_at', async () => {
  await requireColumns(app);
  const list = await columns(app);
  expect(list.find(({ name }) => name === 'fetched_at')?.default_expr).toBeNull();
  for (const column of list) {
    const expression = column.default_expr ?? '';
    expect(expression, column.name).not.toMatch(/\buuidv7\s*\(/i);
    if (column.name !== 'created_at') {
      expect(expression, column.name).not.toMatch(
        /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|current_timestamp|current_date|current_time|localtimestamp|localtime)\b/i,
      );
      expect(expression, column.name).not.toMatch(/'now'/i);
    }
  }
});

it('[AC-B1-04a#6] orders keeps a bigint logical reference and no FK targets the archive or its children', async () => {
  await requireTable(app);
  const reference = await sql<{ type: string }>`
    SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = to_regclass('app.orders') AND attname = 'raw_payload_id'
      AND attnum > 0 AND NOT attisdropped
  `.execute(app);
  expect(reference.rows).toEqual([{ type: 'bigint' }]);
  const incoming = await sql<{ name: string }>`
    WITH RECURSIVE archive(oid) AS (
      SELECT to_regclass('app.union_raw_payloads')::oid
      UNION ALL
      SELECT i.inhrelid FROM pg_inherits i JOIN archive a ON a.oid = i.inhparent
    )
    SELECT c.conname::text AS name FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confrelid IN (SELECT oid FROM archive)
  `.execute(app);
  expect(incoming.rows).toEqual([]);
});

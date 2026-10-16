import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { TABLES, columns, connect, constraints, foreignKeys, requireTable } from './kit.ts';

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

it('[AC-B1-08c#1] all six ordinary app tables have tenant identity and a named primary key', async () => {
  for (const table of TABLES) {
    await requireTable(app, table);
    expect(await columns(table)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'app_id', type: 'text', nullable: false }),
      ]),
    );
    const primary = (await constraints(app, table)).filter((c) => c.kind === 'p');
    expect(primary).toHaveLength(1);
    expect(primary[0]?.name.length).toBeGreaterThan(0);
    expect(primary[0]?.cols.length).toBeGreaterThan(0);
    const id = (await columns(table)).find((column) => column.name === 'id');
    if (id) {
      expect(['uuid', 'int8']).toContain(id.type);
      expect(id.nullable).toBe(false);
      if (id.type === 'int8') {
        const identity = await sql<{ identity: string }>`SELECT is_identity AS identity
          FROM information_schema.columns WHERE table_schema = 'app'
          AND table_name = ${table} AND column_name = 'id'`.execute(app);
        expect(identity.rows).toEqual([{ identity: 'YES' }]);
      }
    }
  }
});

it('[AC-B1-08c#2] stream, pending, counter, drop and history columns retain the task shape', async () => {
  const shapes = {
    sync_cursors: [
      ['platform', 'text', false],
      ['union_account_id', 'uuid', false],
      ['query_kind', 'text', false],
      ['scene', 'text', false],
      ['cursor_at', 'timestamptz', false],
      ['updated_at', 'timestamptz', false],
    ],
    order_sync_pending: [
      ['platform', 'text', false],
      ['sub_order_id', 'text', false],
      ['order_id', 'uuid', true],
      ['reason', 'text', false],
      ['raw_status', 'text', true],
      ['raw_payload_id', 'int8', true],
      ['detected_at', 'timestamptz', false],
      ['status', 'text', false],
      ['resolved_at', 'timestamptz', true],
    ],
    order_sync_counters: [
      ['platform', 'text', false],
      ['date', 'date', false],
      ['counter', 'text', false],
      ['count', 'int8', false],
    ],
    order_sync_drops: [
      ['platform', 'text', false],
      ['date', 'date', false],
      ['reason', 'text', false],
      ['count', 'int8', false],
    ],
    order_sync_drop_keys: [
      ['platform', 'text', false],
      ['sub_order_id', 'text', false],
      ['reason', 'text', false],
    ],
    order_status_history: [
      ['order_id', 'uuid', false],
      ['field', 'text', false],
      ['from_status', 'text', true],
      ['event', 'text', false],
      ['to_status', 'text', false],
      ['source', 'text', false],
      ['at', 'timestamptz', false],
    ],
  } as const;
  for (const table of TABLES) {
    await requireTable(app, table);
    const actual = await columns(table);
    for (const [name, type, nullable] of shapes[table]) {
      expect(actual, `${table}.${name}`).toEqual(
        expect.arrayContaining([expect.objectContaining({ name, type, nullable })]),
      );
    }
  }
  expect((await columns('order_sync_pending')).map((c) => c.name)).toEqual(
    expect.arrayContaining(['id', 'detail', 'resolved_by', 'resolution_note']),
  );
});

it('[AC-B1-08c#3] business timestamps have no database default and pending status is application supplied', async () => {
  for (const table of TABLES) {
    await requireTable(app, table);
    const defaults = await sql<{ name: string; type: string; expression: string | null }>`
      SELECT column_name AS name, udt_name AS type, column_default AS expression
      FROM information_schema.columns WHERE table_schema = 'app' AND table_name = ${table}
    `.execute(app);
    for (const column of defaults.rows) {
      if (
        ['timestamptz', 'timestamp', 'date'].includes(column.type) &&
        column.name !== 'created_at'
      ) {
        expect(column.expression, `${table}.${column.name}`).toBeNull();
      }
      expect(column.expression ?? '', `${table}.${column.name}`).not.toMatch(/\buuidv7\s*\(/i);
    }
  }
  expect((await columns('order_sync_pending')).find((c) => c.name === 'status')?.hasDefault).toBe(
    false,
  );
});

it('[AC-B1-08c#4] named foreign keys reference accounts and order keys without cascading', async () => {
  for (const [table, column, target, targetColumn] of [
    ['sync_cursors', 'union_account_id', 'union_accounts', 'id'],
    ['order_sync_pending', 'order_id', 'order_keys', 'order_id'],
    ['order_status_history', 'order_id', 'order_keys', 'order_id'],
  ] as const) {
    await requireTable(app, table);
    const fks = await foreignKeys(table);
    const fk = fks.find((key) => key.columns.includes(column) && key.target === target);
    expect(fk, `${table}.${column}`).toBeDefined();
    expect(fk?.name.length).toBeGreaterThan(0);
    expect(fk?.targetColumns[fk.columns.indexOf(column)]).toBe(targetColumn);
  }
  for (const table of TABLES) {
    await requireTable(app, table);
    for (const fk of await foreignKeys(table)) {
      expect(['a', 'r'], fk.name).toContain(fk.onDelete);
      expect(['a', 'r'], fk.name).toContain(fk.onUpdate);
      expect(fk.targetKind, fk.name).toBe('r');
    }
  }
  expect(
    (await foreignKeys('order_sync_pending')).some((fk) => fk.columns.includes('raw_payload_id')),
  ).toBe(false);
});

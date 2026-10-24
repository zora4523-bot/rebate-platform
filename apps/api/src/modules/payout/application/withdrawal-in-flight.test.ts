import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Transaction,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createWithdrawalInFlightReader } from './withdrawal-in-flight.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(rows: unknown[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: rows as R[], numAffectedRows: 0n };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries, clock: new FixedClock('2026-10-24T04:00:00.000Z') };
}

const INPUT = { appId: 'couli', userId: '019a0000-0000-7000-8000-000000000001' };
const ID = '019a0000-0000-7000-8000-0000000000aa';

it('[AC-B1-27j] hasSucceeded is one app- and user-scoped SELECT over PAID_API / PAID_MANUAL', async () => {
  const f = await fixture([{ id: ID }]);
  const reader = createWithdrawalInFlightReader({ clock: f.clock });
  const result = await f.db
    .transaction()
    .execute((trx: Transaction<DB>) => reader.hasSucceeded(trx, INPUT));
  expect(result).toBe(true);
  const reads = f.queries.filter((q) => !/^(begin|commit|rollback)/i.test(q.sql));
  expect(reads).toHaveLength(1);
  expect(reads[0]?.sql).toBe(
    'select "id" from "app"."withdrawals" where "app_id" = $1 and "user_id" = $2 and "status" in ($3, $4) limit $5',
  );
  expect(reads[0]?.parameters).toEqual([INPUT.appId, INPUT.userId, 'PAID_API', 'PAID_MANUAL', 1]);
});

it('[AC-B1-27j] hasSucceeded answers false when no paid-out row is found, and never writes', async () => {
  const f = await fixture([]);
  const reader = createWithdrawalInFlightReader({ clock: f.clock });
  const result = await f.db
    .transaction()
    .execute((trx: Transaction<DB>) => reader.hasSucceeded(trx, INPUT));
  expect(result).toBe(false);
  const reads = f.queries.filter((q) => !/^(begin|commit|rollback)/i.test(q.sql));
  expect(reads).toHaveLength(1);
  expect(reads.every((q) => q.sql.startsWith('select '))).toBe(true);
});

it('[AC-B1-27j] hasNonTerminal still reads the open states only', async () => {
  const f = await fixture([]);
  const reader = createWithdrawalInFlightReader({ clock: f.clock });
  const result = await f.db
    .transaction()
    .execute((trx: Transaction<DB>) => reader.hasNonTerminal(trx, INPUT));
  expect(result).toBe(false);
  const reads = f.queries.filter((q) => !/^(begin|commit|rollback)/i.test(q.sql));
  expect(reads[0]?.parameters).toEqual([
    INPUT.appId,
    INPUT.userId,
    'PENDING_REVIEW',
    'APPROVED',
    'PAYING',
    1,
  ]);
});

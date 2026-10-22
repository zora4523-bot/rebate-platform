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
import { detachChildrenOfDeleted } from '../index.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Compile real Kysely queries against an in-memory driver: no socket or database.
function fixture(results: unknown[][] = []) {
  const driver = new DummyDriver();
  const queries: CompiledQuery[] = [];
  const acquire = driver.acquireConnection.bind(driver);
  driver.acquireConnection = async () => {
    const connection = await acquire();
    connection.executeQuery = async <R>(query: CompiledQuery) => {
      queries.push(query);
      const next = results.shift() ?? [];
      return { rows: next as R[], numAffectedRows: BigInt(next.length) };
    };
    return connection;
  };
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries };
}

const at = new FixedClock('2026-10-22T04:34:56.789Z').now();
const parent = '019a0000-0000-7000-8000-00000000000b';
const childA = '019a0000-0000-7000-8000-00000000000c';
const childB = '019a0000-0000-7000-8000-00000000000d';

function run<T>(db: Kysely<DB>, work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(work);
}

it('[AC-B1-15n] locks children in id order, clears the parent, then logs each detached child', async () => {
  const { db, queries } = fixture([
    [{ id: childA }, { id: childB }],
    [{ id: childA }, { id: childB }],
  ]);
  const result = await run(db, (trx) =>
    detachChildrenOfDeleted(trx, { appId: 'couli', userId: parent, at }),
  );
  expect(result).toStrictEqual({ detached: 2 });
  const statements = queries
    .map((query) => query.sql)
    .filter((text) => !/^(begin|commit)/i.test(text));
  expect(statements).toHaveLength(4);
  expect(statements[0]).toMatch(/from "app"\."users".*order by "id".*for no key update$/s);
  expect(statements[1]).toMatch(
    /^update "app"\."users" set "parent_id" = \$1, "parent_bind_source" = \$2, "parent_bound_at" = \$3/,
  );
  expect(statements[1]).toMatch(/"app_id" = \$\d+ and "parent_id" = \$\d+ and "id" in/);
  expect(statements[2]).toMatch(/^insert into "app"\."relation_change_logs"/);
  const logs = queries.filter((query) => query.sql.startsWith('insert'));
  expect(logs.map((query) => query.parameters)).toStrictEqual([
    ['couli', childA, parent, null, 'parent_deleted', 'system', null, at, at],
    ['couli', childB, parent, null, 'parent_deleted', 'system', null, at, at],
  ]);
});

it('[AC-B1-15n] no direct child: returns zero and writes nothing', async () => {
  const { db, queries } = fixture([[]]);
  const result = await run(db, (trx) =>
    detachChildrenOfDeleted(trx, { appId: 'couli', userId: parent, at }),
  );
  expect(result).toStrictEqual({ detached: 0 });
  expect(queries.some((query) => /^(update|insert)/.test(query.sql))).toBe(false);
});

it('[AC-B1-15n] logs only the rows the conditional update actually detached', async () => {
  const { db, queries } = fixture([[{ id: childA }, { id: childB }], [{ id: childB }]]);
  const result = await run(db, (trx) =>
    detachChildrenOfDeleted(trx, { appId: 'couli', userId: parent, at }),
  );
  expect(result).toStrictEqual({ detached: 1 });
  const logs = queries.filter((query) => query.sql.startsWith('insert'));
  expect(logs.map((query) => query.parameters[1])).toStrictEqual([childB]);
});

it('[AC-B1-15n] rejects a blank app or user and an invalid instant before any SQL', async () => {
  const { db, queries } = fixture();
  for (const input of [
    { appId: '', userId: parent, at },
    { appId: 'couli', userId: ' ', at },
    { appId: 'couli', userId: parent, at: new Date(Number.NaN) },
  ]) {
    await expect(run(db, (trx) => detachChildrenOfDeleted(trx, input))).rejects.toBeInstanceOf(
      TypeError,
    );
  }
  expect(queries.some((query) => /^(select|update|insert)/.test(query.sql))).toBe(false);
});

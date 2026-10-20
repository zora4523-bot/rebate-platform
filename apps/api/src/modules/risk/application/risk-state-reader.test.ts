import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { createRiskStateBatchReader } from './risk-state-reader.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const C = '019a0000-0000-7000-8000-000000000003';
const D = '019a0000-0000-7000-8000-000000000004';
const E = '019a0000-0000-7000-8000-000000000005';

/** A Kysely whose driver records each compiled statement and answers with the given rows. */
function stubDb(rows: readonly Record<string, unknown>[] = []): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows: rows as R[] };
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

it('[AC-B1-02zf] empty request and construction run no query', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createRiskStateBatchReader({ db: factory.db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [] })).resolves.toEqual(new Map());
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toEqual([]);
});

it('[AC-B1-02zf] one users left join user_risk_state select on the caller executor, deduplicated IDs', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createRiskStateBatchReader({ db: factory.db });
  await reader.read(caller.db, { appId: APP, userIds: [B, A, B] });
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toHaveLength(1);
  expect(caller.queries[0]!.sql).toBe(
    'select "app"."users"."id", "app"."user_risk_state"."state", "app"."user_risk_state"."frozen_until"' +
      ' from "app"."users" left join "app"."user_risk_state"' +
      ' on "app"."user_risk_state"."user_id" = "app"."users"."id"' +
      ' and "app"."user_risk_state"."app_id" = "app"."users"."app_id"' +
      ' where "app"."users"."app_id" = $1 and "app"."users"."id" = ANY($2)',
  );
  expect(caller.queries[0]!.parameters).toEqual([APP, [B, A]]);
});

it('[AC-B1-02zf] returns state and frozen_until as stored; a missing row is normal', async () => {
  const past = new Date('2020-01-01T00:00:00.000Z');
  const future = new Date('2099-01-01T00:00:00.000Z');
  const caller = stubDb([
    { id: A, state: 'normal', frozen_until: null },
    { id: B, state: 'frozen', frozen_until: past },
    { id: C, state: 'appealing', frozen_until: future },
    { id: D, state: 'banned', frozen_until: null },
    { id: E, state: null, frozen_until: null },
  ]);
  const reader = createRiskStateBatchReader({ db: stubDb().db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [A, B, C, D, E] })).resolves.toEqual(
    new Map([
      [A, { state: 'normal', frozen_until: null }],
      [B, { state: 'frozen', frozen_until: past }],
      [C, { state: 'appealing', frozen_until: future }],
      [D, { state: 'banned', frozen_until: null }],
      [E, { state: 'normal', frozen_until: null }],
    ]),
  );
});

it('[AC-B1-02zf] a state outside the CHECK is a broken database and throws', async () => {
  const caller = stubDb([{ id: A, state: 'synthetic_corrupt', frozen_until: null }]);
  const reader = createRiskStateBatchReader({ db: stubDb().db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [A] })).rejects.toThrow(
    'risk: unknown user risk state',
  );
});

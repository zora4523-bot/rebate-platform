import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Driver,
  type TransactionSettings,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import {
  createKyselyAgreementAdminStore,
  isAgreementVersionTaken,
} from './kysely-agreement-admin-store.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

type Event =
  | { readonly kind: 'begin'; readonly settings: TransactionSettings }
  | { readonly kind: 'query'; readonly query: CompiledQuery }
  | { readonly kind: 'commit' };

// Real SQL compiler, no database or socket: records statements and transaction boundaries.
async function fixture(pageRows: readonly object[], count: string) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const events: Event[] = [];
  driver.acquireConnection = async () => connection;
  (driver as Driver).beginTransaction = async (_connection, settings) => {
    events.push({ kind: 'begin', settings });
  };
  driver.commitTransaction = async () => {
    events.push({ kind: 'commit' });
  };
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    events.push({ kind: 'query', query });
    const first = events.filter((event) => event.kind === 'query').length === 1;
    return { rows: (first ? pageRows : [{ n: count }]) as R[] };
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
  const store = createKyselyAgreementAdminStore(db, () => ({
    append: () => Promise.reject(new Error('not used')),
  }));
  return { store, events };
}

it('[AC-F1-02z] 协议列表的分页与 total 在同一只读 REPEATABLE READ 事务里顺序读', async () => {
  const f = await fixture([], '3');
  // Past the last page: no rows, the total is still read in the same snapshot.
  expect(await f.store.list('app_a', 'privacy', 40, 20)).toEqual({ items: [], total: 3 });
  expect(f.events.map((event) => event.kind)).toEqual(['begin', 'query', 'query', 'commit']);
  expect(f.events[0]).toEqual({
    kind: 'begin',
    settings: { isolationLevel: 'repeatable read', accessMode: 'read only' },
  });
  const [page, total] = f.events.flatMap((event) => (event.kind === 'query' ? [event.query] : []));
  expect(page!.sql).toContain('from "app"."agreements" as "g"');
  expect(page!.sql).toContain('limit $3 offset $4');
  expect(page!.parameters).toEqual(['app_a', 'privacy', 20, 40]);
  expect(total!.sql).toBe(
    'select count(*) as "n" from "app"."agreements" as "g" where "g"."app_id" = $1 and "g"."type" = $2',
  );
  expect(total!.parameters).toEqual(['app_a', 'privacy']);
});

it('[AC-F1-02z] 不带类型时列表与 total 都只按 app 过滤', async () => {
  const f = await fixture([], '0');
  expect(await f.store.list('app_b', undefined, 0, 20)).toEqual({ items: [], total: 0 });
  const queries = f.events.flatMap((event) => (event.kind === 'query' ? [event.query] : []));
  expect(queries.map((query) => query.parameters)).toEqual([['app_b', 20, 0], ['app_b']]);
});

it('[AC-F1-02p] only a unique violation of the (app_id, type, version) key is a lost race', () => {
  expect(
    isAgreementVersionTaken({ code: '23505', constraint: 'agreements_app_type_version_key' }),
  ).toBe(true);
  expect(isAgreementVersionTaken({ code: '23505', constraint: 'agreements_pkey' })).toBe(false);
  expect(
    isAgreementVersionTaken({ code: '23514', constraint: 'agreements_app_type_version_key' }),
  ).toBe(false);
  expect(isAgreementVersionTaken(null)).toBe(false);
  expect(isAgreementVersionTaken('23505')).toBe(false);
});

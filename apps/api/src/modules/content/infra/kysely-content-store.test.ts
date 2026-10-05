import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { createKyselyContentStore } from './kysely-content-store.ts';

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
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  return { store: createKyselyContentStore(db), queries };
}

it('[AC-F1-02b] minimum versions: one SELECT of app_versions scoped by app and platform', async () => {
  const f = await fixture([
    { channel: 'official', min_supported_version: '2.10.0' },
    { channel: 'huawei', min_supported_version: null },
  ]);
  const byChannel = await f.store.minSupportedVersionsByChannel('app_1', 'android');
  expect([...byChannel]).toEqual([
    ['official', '2.10.0'],
    ['huawei', null],
  ]);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'select "channel", "min_supported_version" from "app"."app_versions" where "app_id" = $1 and "platform" = $2',
  );
  expect(f.queries[0]?.parameters).toEqual(['app_1', 'android']);
});

it('[AC-F1-02b] config: one SELECT of config_items by (app_id, key), version not row_version', async () => {
  const f = await fixture([{ value: { enabled: false }, version: 7, row_version: 30 }]);
  expect(await f.store.configItem('app_1', 'share.domain')).toStrictEqual({
    value: { enabled: false },
    version: 7,
  });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'select "value", "version" from "app"."config_items" where "app_id" = $1 and "key" = $2',
  );
  expect(f.queries[0]?.parameters).toEqual(['app_1', 'share.domain']);
});

it('[AC-F1-02b] config: a row holding JSON null is present; no row is null', async () => {
  const present = await fixture([{ value: null, version: 2 }]);
  expect(await present.store.configItem('app_1', 'nullable')).toStrictEqual({
    value: null,
    version: 2,
  });
  const absent = await fixture([]);
  expect(await absent.store.configItem('app_1', 'missing')).toBeNull();
});

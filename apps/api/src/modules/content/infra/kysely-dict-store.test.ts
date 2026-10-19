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
import { createKyselyDictStore, type DictFilter } from './kysely-dict-store.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

type Event =
  | { readonly kind: 'begin'; readonly settings: TransactionSettings }
  | { readonly kind: 'query'; readonly query: CompiledQuery }
  | { readonly kind: 'commit' };

// Real SQL compiler, no database or socket: records statements and transaction boundaries.
async function fixture(configRows: readonly object[], dicts?: DictFilter) {
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
    return {
      rows: (first ? configRows : [{ dict: 'ai_label', code: '', text: '文案' }]) as R[],
    };
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
  return { store: createKyselyDictStore(db, dicts), events };
}

it('[AC-F1-02s#8] dict_version 与 dict_items 在同一只读 REPEATABLE READ 事务里读', async () => {
  const f = await fixture([{ value: '3' }]);
  const snapshot = await f.store.snapshot('app_a', (value) => (value === '3' ? 3 : null));
  expect(snapshot).toEqual({ value: '3', rows: [{ dict: 'ai_label', code: '', text: '文案' }] });
  expect(f.events.map((event) => event.kind)).toEqual(['begin', 'query', 'query', 'commit']);
  expect(f.events[0]).toEqual({
    kind: 'begin',
    settings: { isolationLevel: 'repeatable read', accessMode: 'read only' },
  });
  const [config, rows] = f.events.flatMap((event) => (event.kind === 'query' ? [event.query] : []));
  expect(config!.sql).toContain('"app"."config_items"');
  expect(config!.parameters).toEqual(['app_a', 'dict_version']);
  expect(rows!.sql).toBe(
    'select distinct on ("dict", "code") "dict", "code", "text" from "app"."dict_items" ' +
      'where "app_id" = $1 and "version" <= $2 order by "dict", "code", "version" desc',
  );
  expect(rows!.parameters).toEqual(['app_a', 3]);
});

it('[AC-F1-02s#5] 缺 dict_version 或上限为 null 时不查 dict_items', async () => {
  const f = await fixture([]);
  expect(await f.store.snapshot('app_b', () => null)).toEqual({ value: undefined, rows: [] });
  expect(f.events.filter((event) => event.kind === 'query')).toHaveLength(1);
});

it('[AC-F1-02zd#u10] 后台只读 admin_dict、公共排除 admin_dict；先读版本再读行，同一只读 REPEATABLE READ 事务', async () => {
  for (const [dicts, clause, value] of [
    [{ only: 'admin_dict' }, '"dict" = $3', 'admin_dict'],
    [{ except: 'admin_dict' }, '"dict" <> $3', 'admin_dict'],
  ] as const) {
    const f = await fixture([{ value: '5' }], dicts);
    await f.store.snapshot('app_z', () => 5);
    expect(f.events.map((event) => event.kind)).toEqual(['begin', 'query', 'query', 'commit']);
    expect(f.events[0]).toEqual({
      kind: 'begin',
      settings: { isolationLevel: 'repeatable read', accessMode: 'read only' },
    });
    const [config, rows] = f.events.flatMap((event) =>
      event.kind === 'query' ? [event.query] : [],
    );
    expect(config!.sql).toContain('"app"."config_items"');
    expect(rows!.sql).toBe(
      'select distinct on ("dict", "code") "dict", "code", "text" from "app"."dict_items" ' +
        `where "app_id" = $1 and "version" <= $2 and ${clause} order by "dict", "code", "version" desc`,
    );
    expect(rows!.parameters).toEqual(['app_z', 5, value]);
  }
});

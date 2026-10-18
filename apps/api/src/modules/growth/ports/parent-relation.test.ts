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
import { FixedClock } from '../../platform/index.ts';
import { createParentRelationReader } from '../index.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Compile real Kysely queries against an in-memory driver: no socket or database.
async function fixture(results: (unknown[] | Error)[] = []) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const next = results.shift() ?? [];
    if (next instanceof Error) throw next;
    return { rows: next as R[] };
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
  return { db, queries };
}

const subject = { appId: 'couli', userId: '019a0000-0000-7000-8000-00000000000a' };
const parent = '019a0000-0000-7000-8000-00000000000b';
const boundAt = new FixedClock('2026-10-17T15:59:59.123Z').now();

it('[AC-B1-11n] 按 app_id 与 id 查一次 users，只取 parent_id 与 parent_bound_at', async () => {
  const { db, queries } = await fixture([[{ parent_id: parent, parent_bound_at: boundAt }]]);
  const result = await createParentRelationReader({ db }).relationOf(subject);
  expect(result).toStrictEqual({ has_parent: true, parent_bound_at: boundAt });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toBe(
    'select "parent_id", "parent_bound_at" from "users" where "app_id" = $1 and "id" = $2',
  );
  expect(queries[0]!.parameters).toEqual([subject.appId, subject.userId]);
});

it('[AC-B1-11n] 返回对象恰为两个键，不含上级 id', async () => {
  const { db } = await fixture([[{ parent_id: parent, parent_bound_at: null }]]);
  const result = await createParentRelationReader({ db }).relationOf(subject);
  expect(result).toStrictEqual({ has_parent: true, parent_bound_at: null });
  expect(Reflect.ownKeys(result!)).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain(parent);
});

it.each([
  { stored: null, label: '无绑定时刻' },
  { stored: boundAt, label: '脏数据带绑定时刻' },
])('[AC-B1-11n] 无上级（$label）归一为 false 与 null', async ({ stored }) => {
  const { db } = await fixture([[{ parent_id: null, parent_bound_at: stored }]]);
  expect(await createParentRelationReader({ db }).relationOf(subject)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
});

it('[AC-B1-11n] 查不到行返回 null，且每次调用都重新查询', async () => {
  const { db, queries } = await fixture([[], [{ parent_id: parent, parent_bound_at: boundAt }]]);
  const reader = createParentRelationReader({ db });
  expect(await reader.relationOf(subject)).toBeNull();
  expect(await reader.relationOf(subject)).toStrictEqual({
    has_parent: true,
    parent_bound_at: boundAt,
  });
  expect(queries).toHaveLength(2);
});

it('[AC-B1-11n] 数据库错误原样抛出', async () => {
  const failure = new Error('synthetic database failure');
  const { db } = await fixture([failure]);
  await expect(createParentRelationReader({ db }).relationOf(subject)).rejects.toBe(failure);
});

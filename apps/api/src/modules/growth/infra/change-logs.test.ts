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
import { createRootLogger, FixedClock } from '../../platform/index.ts';
import { appendLevelChange, appendRelationChange, createGrowthHistory } from '../index.ts';
import type { LevelChangeInput, RelationChangeInput } from '../index.ts';

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
    return { rows: next as R[], numAffectedRows: 1n };
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
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'warn', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { db, queries, history: createGrowthHistory({ logger }), lines };
}

const at = new FixedClock('2026-10-20T02:00:00.123Z').now();
const user = '019a0000-0000-7000-8000-00000000000a';
const parent = '019a0000-0000-7000-8000-00000000000b';
const level: LevelChangeInput = {
  app_id: 'couli',
  user_id: user,
  from_level: 'L1',
  to_level: 'L2',
  source: 'admin',
  operator: 'admin:reviewer',
  reason: 'review',
  effective_at: at,
};
const relation: RelationChangeInput = {
  app_id: 'couli',
  user_id: user,
  from_parent_id: null,
  to_parent_id: parent,
  source: 'landing',
  operator: `user:${user}`,
  reason: null,
  at,
};

it.each([
  { to_level: 'L4' },
  { from_level: 'L4' },
  { source: 'auto' },
  { source: 'register' },
  { from_level: null },
  { from_level: 'L2' },
  { reason: null },
  { reason: ' \t\n' },
  { operator: '' },
  { operator: ' \n' },
  { effective_at: new Date(Number.NaN) },
  { effective_at: undefined },
  { effective_at: at.toISOString() },
  { reason: undefined },
  { user_id: '' },
  { app_id: '' },
])('[AC-B1-11b#5] invalid level input is rejected before SQL: %j', async (patch) => {
  const f = await fixture();
  await f.db.transaction().execute(async (trx) => {
    await expect(
      appendLevelChange(trx, { ...level, ...patch } as LevelChangeInput),
    ).rejects.toBeInstanceOf(TypeError);
  });
  expect(f.queries).toEqual([]);
});

it.each([
  { source: 'invite' },
  { from_parent_id: parent },
  { to_parent_id: null },
  { to_parent_id: user },
  { to_parent_id: user.toUpperCase() },
  { from_parent_id: parent.toUpperCase() },
  { source: 'parent_deleted' },
  { operator: ' \t' },
  { at: new Date(Number.NaN) },
  { at: undefined },
  { at: 1 },
  { from_parent_id: undefined },
  { to_parent_id: '' },
  { reason: undefined },
])('[AC-B1-11b#6] invalid relation input is rejected before SQL: %j', async (patch) => {
  const f = await fixture();
  await f.db.transaction().execute(async (trx) => {
    await expect(
      appendRelationChange(trx, { ...relation, ...patch } as RelationChangeInput),
    ).rejects.toBeInstanceOf(TypeError);
  });
  expect(f.queries).toEqual([]);
});

it('[AC-B1-11b#4] inserts preserve caller time and omit untrusted extra columns', async () => {
  const f = await fixture();
  await f.db.transaction().execute(async (trx) => {
    await appendLevelChange(trx, { ...level, id: 999n, created_at: at } as LevelChangeInput);
    await appendRelationChange(trx, relation);
  });
  expect(f.queries).toHaveLength(2);
  expect(f.queries[0]?.sql).toBe(
    'insert into "app"."level_change_logs" ("app_id", "user_id", "from_level", "to_level", "source", "operator", "reason", "effective_at") values ($1, $2, $3, $4, $5, $6, $7, $8)',
  );
  expect(f.queries[0]?.parameters).toEqual([
    'couli',
    user,
    'L1',
    'L2',
    'admin',
    'admin:reviewer',
    'review',
    at,
  ]);
  expect(f.queries[1]?.sql).toBe(
    'insert into "app"."relation_change_logs" ("app_id", "user_id", "from_parent_id", "to_parent_id", "source", "operator", "reason", "at", "created_at") values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  );
  expect(f.queries[1]?.parameters).toEqual([
    'couli',
    user,
    null,
    parent,
    'landing',
    `user:${user}`,
    null,
    at,
    at,
  ]);
});

it('[AC-B1-11t#7] relation insert binds created_at to the caller instant for bind, rebind and unbind', async () => {
  const f = await fixture();
  const past = new FixedClock('2026-10-10T10:00:00.789+08:00').now();
  const inputs: RelationChangeInput[] = [
    { ...relation, at: past },
    {
      ...relation,
      from_parent_id: parent,
      to_parent_id: user.replace(/a$/, 'c'),
      source: 'admin',
      operator: 'admin:reviewer',
      at: past,
    },
    {
      ...relation,
      from_parent_id: parent,
      to_parent_id: null,
      source: 'admin',
      operator: 'admin:reviewer',
      at: past,
    },
    {
      ...relation,
      from_parent_id: parent,
      to_parent_id: null,
      source: 'parent_deleted',
      operator: 'system',
      at: past,
    },
  ];
  await f.db.transaction().execute(async (trx) => {
    for (const input of inputs) await appendRelationChange(trx, input);
    await appendLevelChange(trx, level);
  });
  expect(f.queries).toHaveLength(5);
  for (const query of f.queries.slice(0, 4)) {
    expect(query.sql).toMatch(/"at", "created_at"\) values \(.*\$8, \$9\)$/);
    expect(query.parameters.at(-2)).toBe(past);
    expect(query.parameters.at(-1)).toBe(past);
  }
  expect(f.queries[4]?.sql).not.toContain('created_at');
});

it('[AC-B1-11b#7] a database error escapes unchanged with no retry', async () => {
  const error = Object.assign(new Error('duplicate register'), { code: '23505' });
  const f = await fixture([error]);
  await expect(
    f.db.transaction().execute((trx) =>
      appendLevelChange(trx, {
        ...level,
        from_level: null,
        source: 'register',
        reason: null,
        operator: 'system',
      }),
    ),
  ).rejects.toBe(error);
  expect(f.queries).toHaveLength(1);
});

it('[AC-B1-11b#9][AC-B1-11b#12] level replay uses inclusive time, deterministic ties and account scope', async () => {
  const f = await fixture([[{ to_level: 'L3' }]]);
  await expect(f.history.levelAt(f.db, { app_id: 'couli', user_id: user, at })).resolves.toEqual({
    level: 'L3',
    missing: false,
  });
  expect(f.queries[0]?.sql).toBe(
    'select "to_level" from "app"."level_change_logs" where "app_id" = $1 and "user_id" = $2 and "effective_at" <= $3 order by "effective_at" desc, "id" desc limit $4',
  );
  expect(f.queries[0]?.parameters).toEqual(['couli', user, at, 1]);
  expect(f.lines).toEqual([]);
});

it('[AC-B1-11b#11] missing level falls back to literal L1 and warns on each uncached read', async () => {
  const f = await fixture([[], []]);
  const query = { app_id: 'couli', user_id: user, at };
  expect(await f.history.levelAt(f.db, query)).toEqual({ level: 'L1', missing: true });
  expect(await f.history.levelAt(f.db, query)).toEqual({ level: 'L1', missing: true });
  expect(f.queries).toHaveLength(2);
  expect(f.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    expect.objectContaining({
      level: 40,
      msg: 'growth_level_log_missing',
      app_id: 'couli',
      user_id: user,
    }),
    expect.objectContaining({
      level: 40,
      msg: 'growth_level_log_missing',
      app_id: 'couli',
      user_id: user,
    }),
  ]);
});

it('[AC-B1-11b#9] an invalid stored level fails closed instead of being treated as missing', async () => {
  const f = await fixture([[{ to_level: 'L4' }]]);
  await expect(f.history.levelAt(f.db, { app_id: 'couli', user_id: user, at })).rejects.toThrow(
    'outside user_level',
  );
  expect(f.lines).toEqual([]);
});

it('[AC-B1-11b#15][AC-B1-11b#18] parent replay has inclusive time and deterministic ties, including unlink and missing', async () => {
  const f = await fixture([[{ to_parent_id: parent }], [{ to_parent_id: null }], []]);
  const query = { app_id: 'couli', user_id: user, at };
  await f.db.transaction().execute(async (trx) => {
    expect(await f.history.parentAt(trx, query)).toBe(parent);
    expect(await f.history.parentAt(trx, query)).toBeNull();
    expect(await f.history.parentAt(trx, query)).toBeNull();
  });
  expect(f.queries[0]?.sql).toBe(
    'select "to_parent_id" from "app"."relation_change_logs" where "app_id" = $1 and "user_id" = $2 and "at" <= $3 order by "at" desc, "id" desc limit $4',
  );
  expect(f.queries[0]?.parameters).toEqual(['couli', user, at, 1]);
  expect(f.queries).toHaveLength(3);
  expect(f.lines).toEqual([]);
});

it('[AC-B1-11b#9] invalid replay time does not reach SQL', async () => {
  const f = await fixture();
  const query = { app_id: 'couli', user_id: user, at: new Date(Number.NaN) };
  await expect(f.history.levelAt(f.db, query)).rejects.toBeInstanceOf(TypeError);
  await expect(f.history.parentAt(f.db, query)).rejects.toBeInstanceOf(TypeError);
  expect(f.queries).toEqual([]);
});

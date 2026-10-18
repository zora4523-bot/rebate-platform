import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createFirstAppLoginReview, type FirstAppLoginReviewDeps } from '../index.ts';
import { relationWriteLockKey } from '../infra/relation-lock.ts';

const NOW = '2031-05-06T09:00:00.000Z';
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-00000000000a';
const PARENT = '019a0000-0000-7000-8000-00000000000b';
const HASH = 'ab'.repeat(32);

interface World {
  user: { parent_id: string | null; parent_bind_source: string | null } | undefined;
  inviterHashes: string[];
  updated: bigint;
}

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Compile real Kysely queries against an in-memory driver: no socket or database.
async function fixture(overrides: Partial<World> = {}) {
  const world: World = {
    user: { parent_id: PARENT, parent_bind_source: 'landing' },
    inviterHashes: ['cd'.repeat(32), HASH],
    updated: 1n,
    ...overrides,
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    if (text.startsWith('select "parent_id", "parent_bind_source"')) {
      return { rows: (world.user === undefined ? [] : [world.user]) as R[] };
    }
    if (text.startsWith('SELECT pg_advisory_xact_lock(')) return { rows: [{}] as R[] };
    if (text.startsWith('update "app"."users"')) {
      return { rows: [] as R[], numAffectedRows: world.updated };
    }
    if (text.startsWith('insert into "app"."relation_change_logs"')) {
      return { rows: [] as R[], numAffectedRows: 1n };
    }
    throw new Error(`unexpected query: ${text}`);
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
  const clock = new FixedClock(NOW);
  const read = vi.fn<FirstAppLoginReviewDeps['loginDevices']['read']>(
    async () => world.inviterHashes,
  );
  const record = vi.fn<FirstAppLoginReviewDeps['hitWriter']['record']>(async () => {});
  const review = createFirstAppLoginReview({
    clock,
    loginDevices: { read },
    hitWriter: { record },
  });
  const run = (input: Partial<{ app_id: string; user_id: string; device_id_hash: string }> = {}) =>
    db
      .transaction()
      .execute((trx) =>
        review.review(trx, { app_id: APP, user_id: USER, device_id_hash: HASH, ...input }),
      );
  const writes = () => queries.filter((q) => /^(insert|update|delete)\b/i.test(q.sql));
  return { world, queries, read, record, run, writes };
}

it('[AC-B1-11f#1] hit: lock, conditional update of the three columns, relation log and hit', async () => {
  const f = await fixture();
  await f.run();
  expect(f.read).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    app_id: APP,
    user_id: PARENT,
  });
  const sqls = f.queries.map((q) => q.sql);
  const lock = sqls.findIndex((s) => s.startsWith('SELECT pg_advisory_xact_lock('));
  const update = sqls.findIndex((s) => s.startsWith('update "app"."users"'));
  const log = sqls.findIndex((s) => s.startsWith('insert into "app"."relation_change_logs"'));
  expect(lock).toBeGreaterThan(0);
  expect(update).toBeGreaterThan(lock);
  expect(log).toBeGreaterThan(update);
  expect(f.queries[lock]!.parameters).toEqual([relationWriteLockKey(APP).toString()]);
  const set = f.queries[update]!;
  expect(set.sql).toContain('"parent_id" = $1');
  expect(set.sql).toContain('"parent_bind_source" = $2');
  expect(set.sql).toContain('"parent_bound_at" = $3');
  expect(set.sql).not.toContain('self_bind_used');
  expect(set.sql).toMatch(/where .*"parent_id" = \$\d+ and "parent_bind_source" = \$\d+$/);
  expect(set.parameters).toEqual([null, null, null, new Date(NOW), APP, USER, PARENT, 'landing']);
  expect(f.queries[log]!.parameters).toEqual([
    APP,
    USER,
    PARENT,
    null,
    'risk_same_device',
    'system',
    null,
    new Date(NOW),
  ]);
  expect(f.record).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    app_id: APP,
    user_id: USER,
    rule_id: 'inv_09_same_device',
    dimension: 'device_id_hash',
    value_hmac: HASH,
  });
});

it('[AC-B1-11f#2] the inviter never used this device: no lock, no write, no hit', async () => {
  const f = await fixture({ inviterHashes: ['cd'.repeat(32)] });
  await f.run();
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
  expect(f.writes()).toEqual([]);
  expect(f.record).not.toHaveBeenCalled();
});

it.each([
  { parent_id: PARENT, parent_bind_source: 'register' },
  { parent_id: PARENT, parent_bind_source: null },
  { parent_id: null, parent_bind_source: null },
  { parent_id: null, parent_bind_source: 'landing' },
])('[AC-B1-11f#3] not a landing relation (%o): no device read, no write', async (user) => {
  const f = await fixture({ user });
  await f.run();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.writes()).toEqual([]);
  expect(f.record).not.toHaveBeenCalled();
});

it('[AC-B1-11f#8] the conditional update matched nothing: no relation log and no hit', async () => {
  const f = await fixture({ updated: 0n });
  await f.run();
  expect(f.writes().map((q) => q.sql.slice(0, 20))).toEqual(['update "app"."users"']);
  expect(f.record).not.toHaveBeenCalled();
});

it('[AC-B1-11f#6] a failing hit write rejects to the caller', async () => {
  const f = await fixture();
  const failure = new Error('risk_hits failed');
  f.record.mockRejectedValueOnce(failure);
  await expect(f.run()).rejects.toBe(failure);
});

it('[AC-B1-11f#5] malformed input or a missing subject throws before any write', async () => {
  const f = await fixture();
  await expect(f.run({ device_id_hash: '' })).rejects.toThrow(TypeError);
  await expect(f.run({ app_id: '' })).rejects.toThrow(TypeError);
  expect(f.queries).toEqual([]);
  f.world.user = undefined;
  await expect(f.run()).rejects.toThrow('subject not found');
  expect(f.writes()).toEqual([]);
  expect(f.read).not.toHaveBeenCalled();
});

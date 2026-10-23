// Unit tests of the B1-34h review r1 S2 fix without a database: create and retry hold the
// creator's admin_users row FOR SHARE first and write nothing once it is no longer active. Kysely
// runs on a scripted driver that records the statements; the PostgreSQL locking itself is covered
// by the rule tests.
import { randomUUID } from 'node:crypto';
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
import { expect, it, vi } from 'vitest';
import { FixedClock, type ExportStore, type JobQueue } from '../../platform/index.ts';
import { createAdminExports, ExportCreatorInactiveError } from './admin-exports.ts';

const APP = 'couli';
const ADMIN = randomUUID();
const NOW = '2026-10-09T02:00:00.000Z';

function setup(creatorStatus: string | null) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      if (compiled.sql.includes('from "app"."admin_users"')) {
        const rows = creatorStatus === null ? [] : [{ status: creatorStatus }];
        return Promise.resolve({ rows } as QueryResult<R>);
      }
      if (compiled.sql.startsWith('insert into "app"."export_tasks"')) {
        return Promise.resolve({
          rows: [{ id: randomUUID(), app_id: APP, public_id: 'exp_x', created_by: ADMIN }],
        } as QueryResult<R>);
      }
      return Promise.resolve({ rows: [], numAffectedRows: 1n } as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const queue = { send: vi.fn(async () => 'job') } as unknown as JobQueue;
  const exports = createAdminExports({
    db,
    clock: new FixedClock(NOW),
    queue,
    store: {} as ExportStore,
    profiles: { permissionKeys: async () => [] },
    names: { displayNames: async () => new Map() },
  });
  const actor = { appId: APP, adminId: ADMIN, isSuper: true, loginName: 'ops' };
  return { exports, statements, queue, actor };
}

const failedTask = {
  id: randomUUID(),
  app_id: APP,
  public_id: 'exp_failed',
  created_by: ADMIN,
  resource: 'users',
  masked: true,
  status: 'failed',
  row_version: 3,
} as never;

it.each([
  ['disabled', 'disabled'],
  ['gone', null],
] as const)(
  '[AC-B1-34h] a creator %s by the time create runs writes nothing (10001 upstream)',
  async (_label, status) => {
    const s = setup(status);
    await expect(
      s.exports.create(s.actor, { resource: 'users', filters: {} }, null),
    ).rejects.toBeInstanceOf(ExportCreatorInactiveError);
    expect(s.statements[0]).toMatch(/from "app"\."admin_users".* for share$/);
    expect(s.statements.some((text) => text.startsWith('insert'))).toBe(false);
    expect(s.queue.send).not.toHaveBeenCalled();
  },
);

it('[AC-B1-34h] a disabled creator cannot retry: no update, no job', async () => {
  const s = setup('disabled');
  await expect(
    s.exports.retry(s.actor, { task: failedTask, reason: null }, null),
  ).rejects.toBeInstanceOf(ExportCreatorInactiveError);
  expect(s.statements.some((text) => text.startsWith('update'))).toBe(false);
  expect(s.queue.send).not.toHaveBeenCalled();
});

it('[AC-B1-34h] an active creator locks its row before the task is inserted', async () => {
  const s = setup('active');
  await s.exports.create(s.actor, { resource: 'users', filters: {} }, null).catch(() => undefined);
  const lock = s.statements.findIndex((text) => text.includes('from "app"."admin_users"'));
  const insert = s.statements.findIndex((text) =>
    text.startsWith('insert into "app"."export_tasks"'),
  );
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(insert).toBeGreaterThan(lock);
});

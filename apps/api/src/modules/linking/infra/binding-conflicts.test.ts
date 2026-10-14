// Unit tests of the conflict log's lock without a database (B1-06z, Codex money review r1 S1):
// Kysely runs on a scripted driver that records each compiled statement. They pin the order the
// rule tests cannot provoke on a real PostgreSQL: a conflict write takes the (app, user, platform)
// advisory lock before it re-reads the active binding, a resolution on a path to active takes the
// same lock before it updates, and another user or platform gets another key. Every path to
// active (Taobao bindings, Pinduoduo authority query) resolves through resolveBindingConflictsOnActive.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/linking/relation-conflict).
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
import { describe, expect, it } from 'vitest';
import {
  bindingConflictLockKey,
  recordBindingConflict,
  resolveBindingConflictsOnActive,
} from './binding-conflicts.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const OTHER_USER = '019a0000-0000-7000-8000-0000000000a2';
const ACCOUNT = '019a0000-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-14T02:00:00.000Z');

/** A short label of one statement: what the order assertions compare. */
function label(text: string): string {
  if (text.includes('pg_advisory_xact_lock')) return 'lock';
  if (text.startsWith('select') && text.includes('from "union_bindings"')) return 'select:bindings';
  if (text.startsWith('insert into "union_binding_conflicts"')) return 'insert:conflicts';
  if (text.startsWith('update "union_binding_conflicts"')) return 'update:conflicts';
  return `other:${text.split(' ')[0] ?? ''}`;
}

function setup() {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      return Promise.resolve({ rows: [], numAffectedRows: 0n } as QueryResult<R>);
    },
    async *streamQuery() {
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
  const labels = (): string[] => statements.map((s) => label(s.sql));
  const lockKeys = (): unknown[] =>
    statements.filter((s) => label(s.sql) === 'lock').map((s) => s.parameters[0]);
  return { db, labels, lockKeys };
}

describe('conflict log lock (B1-06z, money review r1 S1)', () => {
  it('[AC-B1-06z] a conflict write locks (app, user, platform) before its active re-read', async () => {
    const { db, labels, lockKeys } = setup();
    await recordBindingConflict(db, {
      appId: APP,
      userId: USER,
      platform: 'taobao',
      accountId: ACCOUNT,
      kind: 'occupied',
      now: NOW,
    });
    expect(labels()).toEqual(['lock', 'select:bindings', 'insert:conflicts']);
    expect(lockKeys()).toEqual([bindingConflictLockKey(APP, USER, 'taobao')]);
  }, 10_000);

  it('[AC-B1-06z] a resolution on a path to active takes the same lock before it updates', async () => {
    const { db, labels, lockKeys } = setup();
    await resolveBindingConflictsOnActive(db, APP, USER, 'taobao', NOW);
    await resolveBindingConflictsOnActive(db, APP, USER, 'pdd', NOW);
    expect(labels()).toEqual(['lock', 'update:conflicts', 'lock', 'update:conflicts']);
    expect(lockKeys()).toEqual([
      bindingConflictLockKey(APP, USER, 'taobao'),
      bindingConflictLockKey(APP, USER, 'pdd'),
    ]);
  }, 10_000);

  it('[AC-B1-06z] the key separates apps, users and platforms', () => {
    const key = bindingConflictLockKey(APP, USER, 'taobao');
    expect(bindingConflictLockKey(APP, USER, 'taobao')).toBe(key);
    expect(bindingConflictLockKey(APP, OTHER_USER, 'taobao')).not.toBe(key);
    expect(bindingConflictLockKey(APP, USER, 'pdd')).not.toBe(key);
    expect(bindingConflictLockKey('couli_other', USER, 'taobao')).not.toBe(key);
  }, 10_000);
});

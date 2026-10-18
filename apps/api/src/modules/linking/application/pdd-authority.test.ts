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
import { activatePddBinding } from './pdd-authority.ts';

// Synthetic ids of one app's user and one union account.
const APP = 'synthetic-app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000b1';
const NOW = new Date('2026-10-18T02:00:00.000Z');
const RELEASED_AT = new Date('2026-08-01T00:00:00.000Z');

/**
 * A scripted connection: every statement is recorded, and the answer is chosen by the table it
 * reads. The user's only pdd row is an old released one at row_version 3; `banned` sets the
 * committed risk state.
 */
function scripted(banned = false): { readonly db: Kysely<DB>; readonly statements: string[] } {
  const statements: string[] = [];
  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes('from "users"')) return [{ id: USER }];
    if (sql.includes('from "user_risk_state"')) return banned ? [{ state: 'banned' }] : [];
    if (sql.startsWith('insert into "union_bindings"')) {
      return [{ id: '0199a3b4-5c6d-7000-8000-0000000000c2', union_account_id: ACCOUNT }];
    }
    if (sql.includes('from "union_bindings"')) {
      return [
        {
          id: '0199a3b4-5c6d-7000-8000-0000000000c1',
          status: 'released',
          union_account_id: ACCOUNT,
          row_version: 3,
          released_at: RELEASED_AT,
          cooldown_until: RELEASED_AT,
        },
      ];
    }
    return [];
  };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      return { rows: rowsFor(query.sql) as R[], numAffectedRows: 0n };
    },
    async *streamQuery() {
      throw new Error('not streamed');
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
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

const clock = { now: () => NOW } as Parameters<typeof activatePddBinding>[1];
const input = { appId: APP, userId: USER, accountId: ACCOUNT, custom: '{"app":"n"}' };

describe('activatePddBinding user lock (F1-07c, BR-ID-20 / BR-ID-31)', () => {
  it('[AC-F1-07c] the user lock comes first; a banned user gets banned and nothing is written', async () => {
    const { db, statements } = scripted(true);
    const written = await activatePddBinding(db, clock, input);
    expect(written).toEqual({ kind: 'banned' });
    expect(statements[0]).toContain('for no key update');
    expect(statements.some((s) => s.startsWith('insert'))).toBe(false);
    expect(statements.some((s) => s.startsWith('update'))).toBe(false);
  });

  it('[AC-F1-07c] a valid filing activates as before, after the lock and outside its savepoints', async () => {
    const { db, statements } = scripted();
    const written = await activatePddBinding(db, clock, input);
    expect(written.kind).toBe('active');
    expect(statements[0]).toContain('for no key update');
    expect(statements.some((s) => s.includes('from "union_auth_sessions"'))).toBe(false);
    expect(statements.some((s) => s.startsWith('insert into "union_bindings"'))).toBe(true);
  });
});

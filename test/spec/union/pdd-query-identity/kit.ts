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
import { expect } from 'vitest';

// Task-local acceptance labels refer to B1-04x's ledger excerpt. All data is synthetic.
export const VARIABLE = 'PDD_QUERY_CUSTOM_PARAMETERS';
export const CUSTOM = '{ "uid" : "synthetic-query-user" }';
export const APP = 'synthetic-app-a';
export const OTHER_APP = 'synthetic-app-b';

/** Capture business failures before asserting; never hide harness/programming errors. */
export async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      (['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AssertionError'].includes(
        error.name,
      ) ||
        ('code' in error && error.code === 'ERR_MODULE_NOT_FOUND'))
    ) {
      throw error;
    }
    return error;
  }
}

export interface Candidate {
  app_id: string;
  platform: string;
  pid_scene: string;
  status: string;
  pid: string;
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    app_id: APP,
    platform: 'pdd',
    pid_scene: 'query',
    status: 'active',
    pid: 'synthetic-query-pid',
    ...overrides,
  };
}

/** Inspect bound equalities, not parameter order or SQL whitespace. */
export function equality(statement: CompiledQuery, column: string): unknown {
  const match = new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`).exec(statement.sql);
  expect(match, `missing equality for ${column}: ${statement.sql}`).not.toBeNull();
  return statement.parameters[Number(match![1]) - 1];
}

export function assertQuery(statement: CompiledQuery, appId: string): void {
  expect(statement.sql).toMatch(/^select\b/i);
  expect(statement.sql).toContain('"app"."union_pids"');
  expect(statement.sql).not.toMatch(/\b(insert|update|delete|for update)\b/i);
  expect(equality(statement, 'app_id')).toBe(appId);
  expect(equality(statement, 'platform')).toBe('pdd');
  expect(equality(statement, 'pid_scene')).toBe('query');
  expect(equality(statement, 'status')).toBe('active');
}

/** Real Kysely compilation; in-memory driver refuses writes and unscoped reads. No PG/socket. */
export function pidDatabase(initial: Candidate[] = [candidate()]) {
  let rows = initial;
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(statement);
      const appId = equality(statement, 'app_id');
      expect(appId).toBeTypeOf('string');
      assertQuery(statement, appId as string);
      const selected = rows.filter(
        (row) =>
          row.app_id === appId &&
          row.platform === equality(statement, 'platform') &&
          row.pid_scene === equality(statement, 'pid_scene') &&
          row.status === equality(statement, 'status'),
      );
      return { rows: selected as R[] };
    },
    async *streamQuery() {
      expect.fail('query identity must not stream rows');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    db,
    statements,
    replace: (next: Candidate[]) => {
      rows = next;
    },
  };
}

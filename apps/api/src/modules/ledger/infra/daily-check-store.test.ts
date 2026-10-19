// Unit tests of the daily_balances write without a database: Kysely runs on a scripted driver
// that records the transaction events and statements. They pin what a real PostgreSQL run cannot
// show deterministically (review r1 S0): the write takes the fixed advisory lock first, in its own
// READ COMMITTED transaction, and reads the entries only in a later statement of that transaction.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/ledger/daily-check).
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
  type TransactionSettings,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { DAILY_BALANCES_LOCK, writeDailyBalances } from './daily-check-store.ts';

function setup(failWrite = false) {
  const events: string[] = [];
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const text = compiled.sql;
      const name = text.includes('pg_advisory_xact_lock')
        ? 'lock'
        : text.includes('INSERT INTO app.daily_balances')
          ? 'upsert'
          : 'other';
      events.push(name);
      if (failWrite && name === 'upsert') return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async (_connection, settings: TransactionSettings) =>
      void events.push(`begin:${settings.isolationLevel ?? 'default'}`),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
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
  return { db, events, statements };
}

const INPUT = {
  accountingDate: '2032-06-15',
  appId: undefined,
  computedAt: new FixedClock('2032-06-15T17:00:00.000Z').now(),
};

it('[AC-B2-02j-UNIT#9] 写日余额先在 READ COMMITTED 事务里取固定键 advisory 锁，再以后续语句读写', async () => {
  const { db, events, statements } = setup();
  await writeDailyBalances(db, INPUT);
  expect(events).toEqual(['begin:read committed', 'lock', 'upsert', 'commit']);
  expect(statements[0]?.sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(statements[0]?.parameters).toEqual([DAILY_BALANCES_LOCK]);
  // Every app and every date share the one key, so all-app runs and single-app re-runs exclude.
  const single = setup();
  await writeDailyBalances(single.db, { ...INPUT, appId: 'app-a', accountingDate: '2032-06-16' });
  expect(single.statements[0]?.parameters).toEqual([DAILY_BALANCES_LOCK]);
  expect(statements[1]?.sql).toContain('FROM app.ledger_entries');
});

it('[AC-B2-02j-UNIT#10] 写入失败时回滚并释放锁所在事务，错误原样抛出', async () => {
  const { db, events } = setup(true);
  await expect(writeDailyBalances(db, INPUT)).rejects.toThrow('boom');
  expect(events).toEqual(['begin:read committed', 'lock', 'upsert', 'rollback']);
});

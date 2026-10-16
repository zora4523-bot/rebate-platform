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
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { harness, outcome, request, response } from './kit.ts';

// Deterministic DB barriers: no network, timers or reliance on which socket wins a race.
function delayedDatabase() {
  const inserted = Promise.withResolvers<void>();
  const releaseInsert = Promise.withResolvers<void>();
  const committing = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  const statements: CompiledQuery[] = [];
  let transactionStarted = false;
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query);
      inserted.resolve();
      await releaseInsert.promise;
      return { rows: [{ id: 1n }] as R[], numAffectedRows: 1n };
    },
    async *streamQuery() {
      expect.fail('archive must not stream');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
    beginTransaction: async () => {
      transactionStarted = true;
    },
    commitTransaction: async () => {
      committing.resolve();
      await releaseCommit.promise;
    },
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
    inserted,
    releaseInsert,
    committing,
    releaseCommit,
    statements,
    transactionStarted: () => transactionStarted,
  };
}

it.each(['success', 'throw'] as const)(
  '[AC-B1-04p-ORDER#1] %s 必须等待 INSERT（若显式事务还须 COMMIT）后才交付结果',
  async (mode) => {
    const fake = delayedDatabase();
    const h = harness(fake.db);
    const reply = response();
    const failure = new UnionError('upstream_unavailable', 'fake-failure!', 'pdd');
    let completed = false;
    try {
      const wrapped = createArchivingTransport(async () => {
        h.clock.advanceMs(17);
        if (mode === 'throw') throw failure;
        return reply;
      }, h);
      const result = outcome(() => wrapped(request(h.appId))).then((value) => {
        completed = true;
        return value;
      });
      const delivered = result.then(() => 'delivered');
      expect(await Promise.race([fake.inserted.promise.then(() => 'insert'), delivered])).toBe(
        'insert',
      );
      // Drain microtasks while the database remains paused: fire-and-forget must be observable.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(completed).toBe(false);
      expect(fake.statements).toHaveLength(1);
      expect(fake.statements[0]!.sql).toMatch(/^insert into "app"\."union_raw_payloads"/i);
      h.clock.advanceMs(500);
      fake.releaseInsert.resolve();
      const next = await Promise.race([fake.committing.promise.then(() => 'commit'), delivered]);
      if (next === 'commit') {
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(completed).toBe(false);
        fake.releaseCommit.resolve();
      } else {
        expect(fake.transactionStarted()).toBe(false);
      }
      expect(await result).toBe(mode === 'throw' ? failure : reply);
    } finally {
      fake.releaseInsert.resolve();
      fake.releaseCommit.resolve();
      await fake.db.destroy();
    }
  },
);

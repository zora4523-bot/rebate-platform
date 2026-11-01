// B1-06zd: the worker entry over the real queue runtime on a dummy database. The runtime refuses a
// second handler of a queue, so catalog's pool refresh and linking's promotion link prefetch, which
// share queue pool-refresh, only assemble while they share its one handler.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { createWorkerContext } from '../../bootstrap.ts';
import {
  FixedClock,
  JOB_QUEUE,
  createRootLogger,
  loadConfig,
  type QueueRuntime,
} from '../../modules/platform/index.ts';

it('[AC-B1-06zd] with pool refresh and prefetch both installed, pool-refresh is registered once', async () => {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  try {
    const context = await createWorkerContext('worker', {
      config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
      clock: new FixedClock('2026-11-01T03:00:00.000Z'),
      logger: createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }),
      dbHandles: { db, dbRead: null, close: vi.fn(async () => undefined) },
    });
    try {
      // One registration happened: the assembly above did not refuse a second, and a third is.
      const queue = context.get<QueueRuntime>(JOB_QUEUE);
      expect(() => {
        queue.register('pool-refresh', async () => undefined);
      }).toThrow(expect.objectContaining({ code: 'duplicate_handler' }));
    } finally {
      await context.close();
    }
  } finally {
    await db.destroy();
  }
});

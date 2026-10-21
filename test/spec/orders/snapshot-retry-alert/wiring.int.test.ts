import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  createRootLogger,
  type JobHandler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { fixture, assertAlert, capture, HOUR, HANDOFF } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08u#15] worker 注册的 snapshot-retry 处理器使用 runtime 注入的 events', async () => {
  const f = await fixture(db);
  const pending = (await f.pending())[0]!;
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const send = vi.fn(async () => 'synthetic');
  const built = await capture(() =>
    createOrderSyncRuntime({
      db,
      clock: f.clock,
      snapshots: f.port,
      events: { publish: f.publish },
      logger: createRootLogger({ level: 'error', entry: 'worker', appEnv: 'test' }, { write() {} }),
      queue: {
        register,
        send,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
      endpoints: [],
      registry: { registrations: () => [], get: vi.fn() },
      ports: {
        users: () => ({ findByAttrCode: f.findUser }),
        bindings: () => ({ findByRelation: f.findBindings }),
        quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
      },
    }),
  );
  expect(built).toMatchObject({ ok: true });
  const handlers = register.mock.calls.filter(([name]) => name === 'order-sync');
  expect(handlers).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  f.clock.advanceMs(24 * HOUR);
  expect(await capture(() => handlers[0]![1](f.job))).toMatchObject({ ok: true });
  const { trx } = assertAlert(f, pending);
  expect(trx).toBe(f.port.create.mock.calls[0]?.[0]);
  expect((await f.pending())[0]?.resolution_note).toBe(HANDOFF);
  await handlers[0]![1](f.job);
  expect(f.events()).toHaveLength(1);
});

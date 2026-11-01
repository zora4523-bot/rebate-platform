// B1-06zd: CatalogWorkerModule.forWorker's provider over fakes. pool-refresh has one handler in a
// process, which works catalog's refresh job and the jobs of the optional POOL_EXTRA_JOBS port.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type QueueRuntime,
  type ReceivedJob,
} from '../platform/index.ts';
import { CatalogWorkerModule } from './catalog-worker.module.ts';
import type { CatalogConfigReader, GovernedUnion, PoolExtraJobs } from './ports.ts';

const QUEUE = 'pool-refresh';
const EXTRA = 'linking.promo_prefetch';

type Factory = (...args: unknown[]) => { onModuleDestroy(): Promise<void> };

const databases: Kysely<DB>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function dummyDb(): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  databases.push(db);
  return db;
}

function job(name: string, attempt = 1): ReceivedJob {
  return {
    id: 'job-1',
    queue: QUEUE,
    name,
    // On the dummy database no row is online, so a refresh job ends without asking the union.
    payload: { app_id: 'app-1', product_key: 'tb:K1', platform: 'taobao' },
    attempt,
  };
}

function assemble(extraJobs?: PoolExtraJobs) {
  const module = CatalogWorkerModule.forWorker({
    ports: { module: class PortsStub {} },
    config: () => ({ configValue: vi.fn() }) as unknown as CatalogConfigReader,
  });
  const provider = module.providers![0] as { useFactory: Factory };
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  provider.useFactory(
    new FixedClock('2026-11-01T03:00:00.000Z'),
    createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }),
    { adapter: vi.fn() } as unknown as GovernedUnion,
    dummyDb(),
    { register } as unknown as QueueRuntime,
    undefined,
    extraJobs,
  );
  return register;
}

it('[AC-B1-06zd] the queue gets one handler, which sends a job by its name', async () => {
  const extra = vi.fn<JobHandler>(async () => undefined);
  const register = assemble(new Map([[EXTRA, extra]]));

  expect(register.mock.calls.map(([queue]) => queue)).toEqual([QUEUE]);
  const handler = register.mock.calls[0]![1];

  const prefetch = job(EXTRA);
  await handler(prefetch);
  expect(extra).toHaveBeenCalledExactlyOnceWith(prefetch);

  await handler(job('refresh'));
  expect(extra).toHaveBeenCalledOnce();
});

it('[AC-B1-06zd] a job name nobody works fails, with and without extra jobs', async () => {
  const extras = new Map([[EXTRA, vi.fn<JobHandler>(async () => undefined)]]);
  for (const register of [assemble(extras), assemble()]) {
    const handler = register.mock.calls[0]![1];
    await expect(handler(job('constructor'))).rejects.toThrow(
      'pool-refresh: unknown job constructor',
    );
  }
  expect(extras.get(EXTRA)).not.toHaveBeenCalled();

  const plain = assemble().mock.calls[0]![1];
  await expect(plain(job(EXTRA))).rejects.toThrow(`pool-refresh: unknown job ${EXTRA}`);
});

it('[AC-B1-06zd] each job kind decides its own retry: a failed extra job fails only its delivery', async () => {
  const failure = new Error('prefetch failed');
  const extra = vi.fn<JobHandler>().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  const handler = assemble(new Map([[EXTRA, extra]])).mock.calls[0]![1];

  await expect(handler(job(EXTRA))).rejects.toBe(failure);
  await expect(handler(job('refresh'))).resolves.toBeUndefined();
  await expect(handler(job(EXTRA, 2))).resolves.toBeUndefined();
  expect(extra.mock.calls.map(([received]) => received.attempt)).toEqual([1, 2]);
});

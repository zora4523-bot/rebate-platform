import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import {
  MAX_PARAM_LENGTH,
  QUEUE_START,
  createHttpApp,
  createWorkerContext,
  queueStarter,
} from './bootstrap.ts';
import {
  APP_CONFIG,
  APP_ENTRY,
  CLOCK,
  ConfigError,
  FixedClock,
  HTTP_ENTRIES,
  JOB_QUEUE,
  OffsetClock,
  type QueueRuntime,
  ROOT_LOGGER,
  SystemClock,
  WORKER_ENTRIES,
  createRootLogger,
  loadConfig,
} from './modules/platform/index.ts';

const config = loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' });

function overrides(entry: string) {
  return {
    config,
    clock: new FixedClock('2026-10-01T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createHttpApp', () => {
  it.each(HTTP_ENTRIES)('builds, serves /healthz and closes the %s entry', async (entry) => {
    const app = await createHttpApp(entry, overrides(entry));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { entry: string } }>().data.entry).toBe(entry);
    expect(app.get(APP_ENTRY)).toBe(entry);
    expect(app.getHttpServer().listening).toBe(false);
    await app.close();
  });

  it('answers unknown routes with 404', async () => {
    const app = await createHttpApp('api', overrides('api'));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('exposes the platform providers given as overrides', async () => {
    const given = overrides('admin');
    const app = await createHttpApp('admin', given);
    await app.init();
    expect(app.get(APP_CONFIG)).toBe(config);
    expect(app.get(CLOCK)).toBe(given.clock);
    expect(app.get(ROOT_LOGGER)).toBe(given.logger);
    await app.close();
  });

  it.each(HTTP_ENTRIES)(
    '[AC-F1-06s] only the admin entry parses multipart/form-data (%s)',
    async (entry) => {
      const app = await createHttpApp(entry, overrides(entry));
      await app.init();
      const server = app.getHttpAdapter().getInstance();
      expect(server.hasContentTypeParser('multipart/form-data')).toBe(entry === 'admin');
      expect(server.initialConfig.bodyLimit).toBe(1_048_576);
      await app.close();
    },
  );

  it.each(HTTP_ENTRIES)(
    '[AC-B1-01zze] routes path parameters up to the percent-encoded contract maximum (%s)',
    async (entry) => {
      // ProductKey (maxLength 128) is the contract's longest path parameter; fully
      // percent-encoded it is three times as long, above Fastify's default limit of 100.
      expect(MAX_PARAM_LENGTH).toBeGreaterThanOrEqual(128 * 3);
      const app = await createHttpApp(entry, overrides(entry));
      const server = app.getHttpAdapter().getInstance();
      expect(server.initialConfig.routerOptions?.maxParamLength).toBe(MAX_PARAM_LENGTH);
      await app.close();
    },
  );
});

describe('createWorkerContext', () => {
  it.each(WORKER_ENTRIES)(
    'builds and closes the %s entry without an HTTP server',
    async (entry) => {
      const context = await createWorkerContext(entry, overrides(entry));
      expect(context.get(APP_ENTRY)).toBe(entry);
      expect(context.get(CLOCK)).toBeInstanceOf(FixedClock);
      await context.close();
    },
  );
});

describe('defaults from process.env', () => {
  it('loads the configuration and derives the clock from CLOCK_NOW', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('CLOCK_NOW', '2026-10-31T12:00:00+08:00');
    const context = await createWorkerContext('worker');
    expect(context.get(APP_CONFIG)).toMatchObject({ appEnv: 'test', logLevel: 'silent' });
    const clock = context.get<OffsetClock>(CLOCK);
    expect(clock).toBeInstanceOf(OffsetClock);
    expect(clock.now().toISOString()).toMatch(/^2026-10-31T04:00:/);
    await context.close();

    vi.stubEnv('CLOCK_NOW', undefined);
    const realTime = await createWorkerContext('payout');
    expect(realTime.get(CLOCK)).toBeInstanceOf(SystemClock);
    await realTime.close();
  });

  it('refuses to build when the environment is invalid', async () => {
    vi.stubEnv('APP_ENV', 'prod');
    vi.stubEnv('CLOCK_NOW', '2026-10-01T00:00:00Z');
    await expect(createHttpApp('api')).rejects.toBeInstanceOf(ConfigError);
    vi.stubEnv('APP_ENV', undefined);
    vi.stubEnv('CLOCK_NOW', undefined);
    await expect(createWorkerContext('worker')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('startQueue (B1-12g)', () => {
  function dummyHandles() {
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (handle) => new PostgresIntrospector(handle),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { db, dbRead: null, close: vi.fn(async () => undefined) };
  }

  it('[AC-B1-12g] the bootstrap hook starts the queue and rejects with its error', async () => {
    const error = new Error('start failed');
    const start = vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockRejectedValueOnce(error);
    const starter = queueStarter({ start });
    expect(start).not.toHaveBeenCalled();
    await expect(starter.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(starter.onApplicationBootstrap()).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('[AC-B1-12g] with database handles init starts the real JOB_QUEUE by default; close stops it before the handles close', async () => {
    const handles = dummyHandles();
    try {
      const app = await createHttpApp('api', { ...overrides('api'), dbHandles: handles });
      const queue = app.get<QueueRuntime>(JOB_QUEUE);
      const events: string[] = [];
      const start = vi.spyOn(queue, 'start').mockImplementation(async () => {
        events.push('start');
      });
      const stop = vi.spyOn(queue, 'stop').mockImplementation(async () => {
        events.push('stop');
      });
      handles.close.mockImplementation(async () => {
        events.push('handles');
      });
      expect(start).not.toHaveBeenCalled();
      await app.init();
      expect(start).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['start']);
      await app.close();
      expect(stop).toHaveBeenCalled();
      expect(events).toEqual(['start', 'stop', 'handles']);
    } finally {
      await handles.db.destroy();
    }
  });

  it('[AC-B1-12g] a failing queue start rejects init with that error', async () => {
    const handles = dummyHandles();
    try {
      const app = await createHttpApp('api', { ...overrides('api'), dbHandles: handles });
      const error = new Error('queue start failed');
      vi.spyOn(app.get<QueueRuntime>(JOB_QUEUE), 'start').mockRejectedValue(error);
      let caught: unknown;
      await app.init().catch((reason: unknown) => {
        caught = reason;
      });
      expect(caught).toBe(error);
      await app.close();
      expect(handles.close).toHaveBeenCalled();
    } finally {
      await handles.db.destroy();
    }
  });

  it('[AC-B1-12g] startQueue false never starts the queue; without handles none is started', async () => {
    const handles = dummyHandles();
    try {
      const app = await createHttpApp('api', {
        ...overrides('api'),
        dbHandles: handles,
        startQueue: false,
      });
      const start = vi.spyOn(app.get<QueueRuntime>(JOB_QUEUE), 'start');
      expect(() => app.get(QUEUE_START)).toThrow();
      await app.init();
      expect(start).not.toHaveBeenCalled();
      await app.close();
    } finally {
      await handles.db.destroy();
    }
    const plain = await createHttpApp('api', overrides('api'));
    expect(() => plain.get(QUEUE_START)).toThrow();
    await plain.init();
    await plain.close();
  });

  it('[AC-B1-12g] createHttpApp refuses startQueue without database handles', async () => {
    let caught: unknown;
    await createHttpApp('api', { ...overrides('api'), startQueue: true }).catch(
      (reason: unknown) => {
        caught = reason;
      },
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/startQueue needs dbHandles/);
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  ConnectionConfig,
  DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { connection, failure, memoryLogger, type Entry } from './kit.ts';

const NEST_TIMEOUT_MS = 30_000;

// Computed imports keep Nest decorators outside the spec project's erasable-only typecheck.
interface App {
  init(): Promise<void>;
  close(): Promise<void>;
  get(token: unknown): unknown;
}
interface Overrides {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof memoryLogger>['logger'];
  redisUrl: ConnectionConfig['redisUrl'];
}
interface Bootstrap {
  createHttpApp(entry: Entry, overrides: Overrides): Promise<App>;
  createWorkerContext(entry: Entry, overrides: Overrides): Promise<App>;
}
async function bootstrap(): Promise<Bootstrap> {
  return (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as Bootstrap;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['api', 'stream', 'admin', 'worker'] as const)(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] %s 从 bootstrap 注入 Redis；Nest 关闭时调用生命周期',
  async (entry) => {
    const closed = vi.fn(async () => {});
    const handle: RedisHandle = {
      namespace: vi.fn(),
      close: closed,
      onApplicationShutdown: closed,
    };
    const create = vi.spyOn(redisModule, 'createRedisHandle').mockResolvedValue(handle);
    const platform = (await import(
      new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
    )) as Record<string, unknown>;
    expect(platform['REDIS']).toBeDefined();
    const boot = await bootstrap();
    const config = loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
    const { logger } = memoryLogger(entry);
    const redisUrl = connection(entry).redisUrl;
    const overrides = { config, logger, redisUrl };
    const app =
      entry === 'worker'
        ? await boot.createWorkerContext(entry, overrides)
        : await boot.createHttpApp(entry, overrides);
    try {
      await app.init();
      expect(app.get(platform['REDIS'])).toBe(handle);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0].entry).toBe(entry);
      expect(create.mock.calls[0]?.[0].redisUrl).toBe(redisUrl);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(closed).toHaveBeenCalled();
  },
  NEST_TIMEOUT_MS,
);

it(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] payout 不提供 Redis',
  async () => {
    const platform = (await import(
      new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
    )) as Record<string, unknown>;
    expect(platform['REDIS']).toBeDefined();
    const boot = await bootstrap();
    const app = await boot.createWorkerContext('payout', {
      config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
      logger: memoryLogger('payout').logger,
      redisUrl: null,
    });
    try {
      expect(await failure(() => app.get(platform['REDIS']))).toBeInstanceOf(Error);
    } finally {
      await app.close();
    }
  },
  NEST_TIMEOUT_MS,
);

it.each(['api', 'stream', 'admin', 'worker'] as const)(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] runEntry(%s) 把已校验的 REDIS_URL 传入 bootstrap',
  async (entry) => {
    for (const [key, value] of Object.entries({
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      COULI_EXIT_AFTER_INIT: '1',
      DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
      DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/rules',
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }))
      vi.stubEnv(key, value);
    for (const key of [
      'FIELD_KEY_PROVIDER',
      'FIELD_KEYRING_FILE',
      'FIELD_MASTER_KEY_FILE',
      'DATABASE_MAINT_URL',
    ]) {
      vi.stubEnv(key, undefined);
    }
    const boot = await bootstrap();
    const captured: { redisUrl?: ConnectionConfig['redisUrl']; dbHandles?: DbHandles }[] = [];
    const build = async (_entry: Entry, options: Overrides): Promise<App> => {
      const passed = options as Overrides & { dbHandles?: DbHandles };
      captured.push(passed);
      return {
        init: async () => {},
        close: async () => {
          await passed.dbHandles?.close();
        },
        get: () => ({}),
      };
    };
    vi.spyOn(boot, 'createHttpApp').mockImplementation(build);
    vi.spyOn(boot, 'createWorkerContext').mockImplementation(build);
    const runner = (await import(
      new URL('../../../../apps/api/src/entry.ts', import.meta.url).href
    )) as { runEntry(entry: Entry): Promise<void> };
    const previousExitCode = process.exitCode;
    try {
      await runner.runEntry(entry);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.redisUrl?.reveal()).toBe('redis://127.0.0.1:1/0');
    } finally {
      process.exitCode = previousExitCode;
      for (const options of captured) await options.dbHandles?.close();
    }
  },
  NEST_TIMEOUT_MS,
);

it.each(['api', 'stream', 'admin', 'worker'] as const)(
  '[B1-01y §9.2][B1-01y §10] %s 使用真实 Redis 工厂，未执行命令时不可达地址不妨碍 init',
  async (entry) => {
    // No spy or fake transport: construction/init/close must not require a Redis server.
    const platform = (await import(
      new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
    )) as Record<string, unknown>;
    expect(platform['REDIS']).toBeDefined();
    const boot = await bootstrap();
    const overrides = {
      config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
      logger: memoryLogger(entry).logger,
      redisUrl: connection(entry, 'redis://127.0.0.1:1/0').redisUrl,
    };
    const app =
      entry === 'worker'
        ? await boot.createWorkerContext(entry, overrides)
        : await boot.createHttpApp(entry, overrides);
    try {
      await app.init();
      const handle = app.get(platform['REDIS']) as RedisHandle;
      expect(handle).toBeDefined();
      expect(handle).not.toBeNull();
      expect(typeof handle.namespace).toBe('function');
    } finally {
      await app.close();
    }
  },
  NEST_TIMEOUT_MS,
);

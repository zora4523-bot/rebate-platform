// B3-03f 第 9 节 6：入口装配（照 test/spec/agent/stream-recovery/entry.test.ts：按 URL 加载 entry / bootstrap /
// platform，stub 配置、连接与日志，不起真进程、不监听端口、不发真信号）。stream 入口用真 createHttpApp（只把
// listen 换成不开端口的替身、库句柄换成只编译不连库的 Kysely），停机靠 Nest 生命周期钩子、entry.ts 不改：
// - SIGTERM → app.close()：先 runtime.close() 完成，之后才关库；不留计时器；
// - COULI_EXIT_AFTER_INIT=1：init 后关闭、不 listen、不受理；同样先停 runtime 再关库，不留计时器；
// - worker 入口不建 stream 运行体（上下文从不被问 agentStreamToken()）。
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
  agentStreamToken,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { until } from './kit.ts';

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';

interface Platform {
  JOB_QUEUE: symbol;
  PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  loadConfig(env: object): object;
  loadConnectionConfig(...args: unknown[]): object;
  loadMaintConnectionConfig(...args: unknown[]): unknown;
  createRootLogger(...args: unknown[]): unknown;
  createDbHandles(...args: unknown[]): unknown;
  startWorkerServices(parts: { queue: { start(): Promise<void> } }): Promise<{
    stop(): Promise<void>;
  }>;
}
interface HttpApp {
  get(token: unknown, options?: { strict: boolean }): unknown;
  listen(...args: unknown[]): Promise<unknown>;
}
interface Boot {
  createHttpApp(...args: unknown[]): Promise<HttpApp>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}
const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
async function modules() {
  return {
    platform: (await import(src('modules/platform/index.ts'))) as Platform,
    boot: (await import(src('bootstrap.ts'))) as Boot,
    entryModule: (await import(src('entry.ts'))) as { runEntry(entry: Entry): Promise<void> },
  };
}

const databases: Kysely<DB>[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function compileOnlyDb(): Kysely<DB> {
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

function timeouts(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

async function fixture(env: Record<string, string> = {}) {
  const { platform, boot, entryModule } = await modules();
  const token = agentStreamToken();
  expect(typeof token).toBe('symbol');
  const p = await ports();
  const config = platform.loadConfig({ APP_ENV: 'test', ...env });
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue({ redisUrl: null });
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(p.logger);
  const order: string[] = [];
  const dbClose = vi.fn(async () => {
    order.push('db-close');
  });
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: compileOnlyDb(),
    dbRead: null,
    close: dbClose,
  });
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const state: { runtime: AgentStreamRuntime | null; listen: number; tokenGets: number } = {
    runtime: null,
    listen: 0,
    tokenGets: 0,
  };
  // The real stream application; listen is replaced (no port), the runtime's close is observed.
  const createHttpApp = boot.createHttpApp.bind(boot);
  vi.spyOn(boot, 'createHttpApp').mockImplementation(async (...args: unknown[]) => {
    const app = await createHttpApp(...args);
    app.listen = async () => {
      state.listen += 1;
      return undefined;
    };
    if (args[0] === 'stream') {
      const runtime = app.get(token, { strict: false }) as AgentStreamRuntime | null;
      expect(runtime, 'the stream runtime').not.toBeNull();
      const close = runtime!.close.bind(runtime);
      vi.spyOn(runtime!, 'close').mockImplementation(async () => {
        order.push('runtime-close-called');
        await close();
        order.push('runtime-closed');
      });
      state.runtime = runtime;
    }
    return app;
  });
  // The worker: a fake context that records whether the stream token is ever asked for.
  const context = {
    init: async () => undefined,
    close: async () => undefined,
    get: (asked: unknown): unknown => {
      if (asked === platform.JOB_QUEUE) return queue;
      if (asked === token) {
        state.tokenGets += 1;
        return null;
      }
      return null;
    },
  };
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(context);
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => undefined };
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    listener: (...a: unknown[]) => void,
  ) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event as never, listener as never);
  }) as never);
  const msgs = (): string[] => p.lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  return {
    order,
    state,
    msgs,
    dbClose,
    run: (entry: Entry) => entryModule.runEntry(entry),
    signal(signal: 'SIGTERM' | 'SIGINT') {
      expect(handlers.has(signal)).toBe(true);
      handlers.get(signal)!(signal);
    },
  };
}

it('[AC-B3-03f#16][BR-AI-23] stream 入口：SIGTERM → app.close() 时先等 runtime.close() 完成，之后才关库；停机后不留计时器', async () => {
  const before = timeouts();
  const f = await fixture();
  await f.run('stream');
  expect(f.msgs()).toContain('started');
  expect(f.msgs()).not.toContain('startup_failed');
  expect(f.state.listen).toBe(1);
  expect(f.state.runtime).not.toBeNull();
  f.signal('SIGTERM');
  await until('the stream entry stopped', () =>
    f.msgs().some((m) => m === 'stopped' || m === 'shutdown_failed'),
  );
  expect(f.msgs()).toContain('stopped');
  expect(f.order).toEqual(['runtime-close-called', 'runtime-closed', 'db-close']);
  expect(timeouts()).toBeLessThanOrEqual(before);
}, 30_000);

it('[AC-B3-03f#17] COULI_EXIT_AFTER_INIT=1：stream 初始化后关闭、不 listen；先停 runtime 再关库，不留计时器', async () => {
  const before = timeouts();
  const f = await fixture({ COULI_EXIT_AFTER_INIT: '1' });
  await f.run('stream');
  expect(f.msgs()).toContain('started');
  expect(f.state.listen).toBe(0);
  expect(f.order).toEqual(['runtime-close-called', 'runtime-closed', 'db-close']);
  expect(timeouts()).toBeLessThanOrEqual(before);
}, 30_000);

it('[AC-B3-03f#18] worker 入口不建 stream 运行体：上下文从不被问 agentStreamToken()', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.msgs()).toContain('started');
  expect(f.state.tokenGets).toBe(0);
  f.signal('SIGTERM');
  await until('the worker stopped', () =>
    f.msgs().some((m) => m === 'stopped' || m === 'shutdown_failed'),
  );
  expect(f.state.runtime).toBeNull();
}, 30_000);

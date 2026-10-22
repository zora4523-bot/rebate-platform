import { afterEach, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ lines: [] as Record<string, unknown>[] }));

// The real runner still selects and builds its root logger. Only the environment source and
// I/O boundaries are replaced; no real environment values, sockets or database are read.
vi.mock('../../../../apps/api/src/modules/platform/index.ts', async (original) => {
  const real =
    await original<typeof import('../../../../apps/api/src/modules/platform/index.ts')>();
  return {
    ...real,
    loadConfig: () => ({
      ...real.loadConfig({ APP_ENV: 'test', COULI_EXIT_AFTER_INIT: '1' }),
      deployVersion: 'release-entry',
    }),
    loadConnectionConfig: () => ({ redisUrl: null }),
    loadMaintConnectionConfig: () => null,
    createDbHandles: () => ({ close: async () => undefined }),
    createRootLogger: (options: Parameters<typeof real.createRootLogger>[0]) =>
      real.createRootLogger(options, {
        write: (line: string) => captured.lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
  };
});

vi.mock('../../../../apps/api/src/bootstrap.ts', () => ({
  createHttpApp: async () => ({ init: async () => undefined, close: async () => undefined }),
  createWorkerContext: async () => ({ get: () => ({}), close: async () => undefined }),
}));

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-01zzg#9] 真实 runEntry 的五入口启动日志都传入部署版本，不因另建根 logger 而丢失', async () => {
  const entryPath = new URL('../../../../apps/api/src/entry.ts', import.meta.url).href;
  const { runEntry } = (await import(entryPath)) as {
    runEntry(entry: 'api' | 'stream' | 'admin' | 'worker' | 'payout'): Promise<void>;
  };
  const previousExitCode = process.exitCode;
  try {
    for (const entry of ['api', 'stream', 'admin', 'worker', 'payout'] as const) {
      captured.lines.length = 0;
      await runEntry(entry);
      expect(captured.lines.filter((line) => line['msg'] === 'started')).toEqual([
        expect.objectContaining({ entry, deployVersion: 'release-entry', listening: false }),
      ]);
      expect(process.exitCode).toBe(previousExitCode);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

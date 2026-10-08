// Rule test of the real api entry against a real PostgreSQL (contract section 10 of
// apps/api/src/modules/platform/queue/index.ts: every entry starts its queue runtime before it
// reports `started`; PlatformModule provides that runtime as JOB_QUEUE). Gap 3 of followups B1-01g:
// after runEntry('api') started with a reachable database, a send through JOB_QUEUE succeeds.
// runEntry runs in this process (it opens the api port on the loopback); the only seam is a spy on
// bootstrap's createHttpApp that calls the real one and keeps the app it returns, so the test can
// reach JOB_QUEUE and close the app afterwards. Top-level it() only (规划/11 §4.3).
// API_PORT must be 1–65535 (port 0 is rejected by the config), so the port is probed free first;
// another test may take it before the api binds, so a start whose listen failed with EADDRINUSE
// is retried on a fresh port, a bounded number of times. Any other failure is not retried.
import { createServer } from 'node:net';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { observe } from './kit.ts';
import { closeObserver, jobRows, observerOn } from './int-kit.ts';

// Computed imports keep Nest decorators outside the spec project's erasable-only typecheck.
interface App {
  get(token: unknown): unknown;
  listen(...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}
interface Bootstrap {
  createHttpApp(...args: unknown[]): Promise<App>;
}
const href = (file: string): string =>
  new URL(`../../../../apps/api/src/${file}`, import.meta.url).href;

/** Starts of runEntry that may be lost to a port taken between probe and bind. */
const MAX_STARTS = 5;

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

it('[AC-B1-01zm#3] 真实 api 入口（runEntry）连库启动后：经 JOB_QUEUE 的 send 成功，任务以 created 落在 pgboss.job；入口未置退出码', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const apps: App[] = [];
    const signals = {
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT'),
    };
    const previousExitCode = process.exitCode;
    try {
      return await observe(async () => {
        for (const [key, value] of Object.entries({
          APP_ENV: 'test',
          LOG_LEVEL: 'silent',
          COULI_EXIT_AFTER_INIT: '0',
          API_HOST: '127.0.0.1',
          DATABASE_URL: database.urlFor('couli_app'),
          REDIS_URL: 'redis://127.0.0.1:1/0',
        })) {
          vi.stubEnv(key, value);
        }
        for (const key of [
          'CLOCK_NOW',
          'DATABASE_READ_URL',
          'DATABASE_MAINT_URL',
          'FIELD_KEY_PROVIDER',
          'FIELD_KEYRING_FILE',
          'FIELD_MASTER_KEY_FILE',
          'JWT_KEY_ID',
          'JWT_PRIVATE_KEY_PEM',
        ]) {
          vi.stubEnv(key, undefined);
        }
        const boot = (await import(href('bootstrap.ts'))) as Bootstrap;
        const create = boot.createHttpApp.bind(boot);
        // The listen error of the current start, recorded (and rethrown) to tell a lost port apart.
        let listenError: unknown;
        vi.spyOn(boot, 'createHttpApp').mockImplementation(async (...args: unknown[]) => {
          const app = await create(...args);
          apps.push(app);
          const listen = app.listen.bind(app);
          app.listen = async (...listenArgs: unknown[]) => {
            try {
              return await listen(...listenArgs);
            } catch (error) {
              listenError = error;
              throw error;
            }
          };
          return app;
        });
        const platform = (await import(href('modules/platform/index.ts'))) as Record<
          string,
          unknown
        >;
        const runner = (await import(href('entry.ts'))) as {
          runEntry(entry: 'api'): Promise<void>;
        };
        let started = 0;
        for (;;) {
          started += 1;
          listenError = undefined;
          apps.length = 0;
          process.exitCode = undefined;
          vi.stubEnv('API_PORT', String(await freePort()));
          await runner.runEntry('api');
          const lostPort =
            process.exitCode === 1 &&
            (listenError as { code?: unknown } | undefined)?.code === 'EADDRINUSE';
          if (!lostPort || started >= MAX_STARTS) break;
        }
        const exitCode = process.exitCode;
        const queue = apps[0]?.get(platform['JOB_QUEUE']) as JobQueue | undefined;
        const id =
          queue === undefined
            ? null
            : await queue.send('notify', 'order.credited', { k: 1 }, { trx: null });
        const rows = id === null ? [] : await jobRows(observer, id);
        return {
          apps: apps.length,
          exitCode,
          id: typeof id,
          rows: rows.map((row) => [row.queue, row.state]),
        };
      });
    } finally {
      for (const app of apps) await app.close().catch(() => undefined);
      for (const name of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(name)) {
          if (!signals[name].includes(listener)) process.removeListener(name, listener);
        }
      }
      process.exitCode = previousExitCode;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    apps: 1,
    exitCode: undefined,
    id: 'string',
    rows: [['notify', 'created']],
  });
}, 180_000);

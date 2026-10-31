// B2-05o: with config.metrics set, the worker's served /metrics registry exports
// couli_withdrawals_review_overdue, read at scrape time over the worker's own database handle
// through payout's read-only port; the other four entries do not. If that read fails, the whole
// scrape fails (no 0 is exported in its place). The registry is the real createMetricsRegistry (only
// the listener is a stand-in), so the wiring itself is checked, whichever collector option carries
// it. The stand-ins follow B1-01zzp's entry test: the platform exports are spied on the platform
// surface and on platform/metrics, the database compiles and logs every query but never connects
// (B1-01zzi's recordingDb), nothing listens. Dynamic imports keep Nest decorators out of the spec
// project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { MetricsServerOptions } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import { ROOT, families } from '../kit.ts';
import { OVERDUE_METRIC, isOverdueRead, mentionsOverdue, overdueValue } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };

/** The count the stand-in answers for the overdue read (as PostgreSQL's count would). */
const KNOWN_COUNT = 3;

interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

/** B1-01zzp's auto-payout reads: the cap's config rows and today's auto-reviewed withdrawals. */
function isAutoPayoutRead(query: string): boolean {
  return (
    mentions(query, 'config_items') ||
    (mentions(query, 'withdrawals') && /\breviewed_at\b/.test(query))
  );
}

/**
 * The stand-in's answer during a scrape: the known count for the overdue read (every column reads
 * KNOWN_COUNT); no rows for the auto-payout reads and for anything that reads no fund table; one
 * '0' row for each B1-01zzi fund read, so those collections go on as in their own entry tests.
 */
function scrapeRows(query: string): readonly Record<string, unknown>[] {
  if (isOverdueRead(query)) return [numericRow(String(KNOWN_COUNT))];
  if (isAutoPayoutRead(query)) return [];
  const read = FUND_TABLES.filter((table) => mentions(query, table));
  if (read.length === 0) return [];
  if (read[0] === 'order_sync_pending') return [numericRow('0', { reason: 'UNMAPPED_STATUS' })];
  return [numericRow('0')];
}

async function fixture() {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  const config = { ...base, metrics: METRICS_CONFIG } as ReturnType<typeof platform.loadConfig>;
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  const queries: string[] = [];
  // No rows during startup (as in B1-01zzh's and B1-01zzi's tests); `scrape` while scraping.
  const answer: { scrape: ((query: string) => readonly Record<string, unknown>[]) | null } = {
    scrape: null,
  };
  const db = recordingDb(queries, (query) => (answer.scrape === null ? [] : answer.scrape(query)));
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: async () => undefined,
  });
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const app = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => parts.queue.stop() };
  });

  // Only the listener is replaced; the registry handed to it is the real one.
  const servers: { options: MetricsServerOptions }[] = [];
  const startServer = async (serverOptions: MetricsServerOptions) => {
    servers.push({ options: serverOptions });
    return { port: serverOptions.port, close: vi.fn(async () => undefined) };
  };
  vi.spyOn(platform, 'startMetricsServer').mockImplementation(startServer);
  vi.spyOn(metrics, 'startMetricsServer').mockImplementation(startServer);

  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  });
  vi.useFakeTimers();
  return {
    runEntry,
    servers,
    queries,
    answer,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B2-05o#10] worker 的 /metrics 在 scrape 时经本入口库读 withdrawals（review_overdue_at）、导出 couli_withdrawals_review_overdue（gauge、无标签、值为端口读数）、不写、不读数据库时钟；其余四个入口没有该指标、不做该读', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const registry = f.servers.at(-1)!.options.registry;

      f.queries.length = 0;
      f.answer.scrape = scrapeRows;
      const text = await registry.render();
      f.answer.scrape = null;

      if (entry === 'worker') {
        expect(families(text).get(OVERDUE_METRIC), `worker: # TYPE of ${OVERDUE_METRIC}`).toBe(
          'gauge',
        );
        expect(overdueValue(text), 'worker: the port count').toBe(KNOWN_COUNT);
        expect(
          f.queries.some(isOverdueRead),
          'the scrape reads withdrawals by review_overdue_at',
        ).toBe(true);
        expect(f.queries.filter((q) => WRITE_SQL.test(q))).toEqual([]);
        expect(f.queries.filter((q) => SQL_CLOCK.test(q))).toEqual([]);
      } else {
        expect(mentionsOverdue(text), entry).toBe(false);
        expect(f.queries.filter(isOverdueRead), entry).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B2-05o#11] worker 的审核超时读失败时整次 scrape 失败（render 拒绝），不以 0 代替；读恢复后下一次 scrape 导出端口读数', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.servers, 'worker: metrics servers started').toHaveLength(1);
    const registry = f.servers.at(-1)!.options.registry;

    // The failure first: a failed read is never served from a cache afterwards.
    const message = 'stand-in: review overdue read unavailable';
    f.queries.length = 0;
    f.answer.scrape = (query) => {
      if (isOverdueRead(query)) throw new Error(message);
      return scrapeRows(query);
    };
    await expect(registry.render(), 'the scrape fails').rejects.toThrow(message);
    expect(f.queries.some(isOverdueRead), 'the failing scrape tried the overdue read').toBe(true);

    f.answer.scrape = scrapeRows;
    const text = await registry.render();
    f.answer.scrape = null;
    expect(overdueValue(text), 'after recovery').toBe(KNOWN_COUNT);
  } finally {
    f.answer.scrape = null;
    await f.stop();
  }
}, 30_000);

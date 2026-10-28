// B1-01zzp: with config.metrics set, the worker's served /metrics registry exports the two
// auto-payout daily gauges, read at scrape time over the worker's own database handle; the other
// four entries do not. The registry is the real createMetricsRegistry (only the listener is a
// stand-in), so the wiring itself is checked, whichever collector option carries it. The stand-ins
// follow B1-01zzi's entry test: the platform exports are spied on the platform surface and on
// platform/metrics, the database compiles and logs every query but never connects (B1-01zzi's
// recordingDb), nothing listens. Dynamic imports keep Nest decorators out of the spec project's
// TypeScript compilation. D10-393 (c): the cap function the worker hands collectAutoPayoutDaily is
// payout's (B2-11c), wired by entry.ts; platform/** itself imports no payout module.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  AutoPayoutCapSnapshot,
  MetricsServerOptions,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import { ROOT, families } from '../kit.ts';
import {
  MALFORMED_CAPS,
  VALID_CAPS,
  capSnapshot,
  payoutCapFenOf,
  platformImports,
  platformImportsOfPayout,
  shiftedDefaultCap,
  withPayoutDefaultCap,
} from './default-cap-kit.ts';
import { AUTO_METRIC_NAMES, autoGauge, autoNamesIn } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };

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

/** The auto-payout reads: the cap's config rows and today's auto-reviewed withdrawals. */
function isAutoPayoutRead(query: string): boolean {
  return (
    mentions(query, 'config_items') ||
    (mentions(query, 'withdrawals') && /\breviewed_at\b/.test(query))
  );
}

/**
 * The stand-in's answer during a scrape: no rows for the auto-payout reads (so the snapshot is
 * empty, whatever its query shape) and for anything that reads no fund table; one '0' row for each
 * B1-01zzi fund read, so the fund collection goes on as in its own entry test.
 */
function scrapeRows(query: string): readonly Record<string, unknown>[] {
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
  // No rows during startup (as in B1-01zzh's and B1-01zzi's tests); scrapeRows while scraping.
  const answer = { scraping: false };
  const db = recordingDb(queries, (query) => (answer.scraping ? scrapeRows(query) : []));
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

it('[AC-B1-01zzp#13] worker 的 /metrics 在 scrape 时经本入口库读 withdrawals（reviewed_at）与 config_items、导出两个自动到账 gauge（没有行时有 TYPE 行无序列）、不写、不读数据库时钟；其余四个入口没有这两个指标', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const registry = f.servers.at(-1)!.options.registry;

      f.queries.length = 0;
      f.answer.scraping = true;
      const text = await registry.render();
      f.answer.scraping = false;

      if (entry === 'worker') {
        for (const name of AUTO_METRIC_NAMES) {
          expect(families(text).get(name), `worker: # TYPE of ${name}`).toBe('gauge');
          expect(autoGauge(text, name), `worker: ${name} series`).toEqual({});
        }
        expect(
          f.queries.some((q) => mentions(q, 'withdrawals') && /\breviewed_at\b/.test(q)),
          'the scrape reads withdrawals by reviewed_at',
        ).toBe(true);
        expect(
          f.queries.some((q) => mentions(q, 'config_items')),
          'the scrape reads config_items',
        ).toBe(true);
        expect(f.queries.filter((q) => WRITE_SQL.test(q))).toEqual([]);
        expect(f.queries.filter((q) => SQL_CLOCK.test(q))).toEqual([]);
      } else {
        expect(autoNamesIn(text), entry).toEqual([]);
        expect(f.queries.filter(isAutoPayoutRead), entry).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B1-01zzp#16] entry.ts 把 payout 的上限解析（B2-11c autoPayoutConfigOf）注入 worker 的自动到账采集：scrape 时调 collectAutoPayoutDaily 所带的上限函数，对未配置 / 不合法 / 合法的上限与 B2-11c 同值，B2-11c 的默认值一变它随之变（不是 platform 或 entry 另写的默认）；platform/** 不 import payout 模块', async () => {
  // Static: platform/** reaches no payout module; the function comes in through entry.ts.
  expect(platformImports().length, 'imports of platform/** were found').toBeGreaterThan(0);
  expect(platformImportsOfPayout(), 'platform/** imports of modules/payout').toEqual([]);

  const f = await fixture();
  // The collector is replaced (its SQL is the other tests'); what it is handed is recorded.
  const calls: Parameters<typeof metrics.collectAutoPayoutDaily>[] = [];
  const standIn = async (...args: Parameters<typeof metrics.collectAutoPayoutDaily>) => {
    calls.push(args);
    return { totalFen: {}, capFen: {} };
  };
  vi.spyOn(metrics, 'collectAutoPayoutDaily').mockImplementation(standIn);
  if ('collectAutoPayoutDaily' in platform) {
    vi.spyOn(platform as unknown as typeof metrics, 'collectAutoPayoutDaily').mockImplementation(
      standIn,
    );
  }
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.servers, 'worker: metrics servers started').toHaveLength(1);
    f.answer.scraping = true;
    await f.servers.at(-1)!.options.registry.render();
    f.answer.scraping = false;

    expect(calls.length, 'the worker scrape runs collectAutoPayoutDaily').toBeGreaterThan(0);
    const [, clock, capFenOf] = calls.at(-1)!;
    expect(clock.now, 'the worker clock').toEqual(expect.any(Function));
    expect(capFenOf, 'the injected cap function').toEqual(expect.any(Function));
    const cases: (readonly [string, AutoPayoutCapSnapshot])[] = [
      ['no cap row', new Map()],
      ...[...MALFORMED_CAPS, ...VALID_CAPS].map(
        (value) => [JSON.stringify(value), capSnapshot(value)] as const,
      ),
    ];
    for (const [label, snapshot] of cases) {
      expect(capFenOf(snapshot), `cap of ${label}`).toBe(payoutCapFenOf(snapshot));
    }
    // B2-11c's default moves: the injected function follows (it is B2-11c's, not a copy).
    const shifted = shiftedDefaultCap();
    await withPayoutDefaultCap(shifted, () => {
      expect(capFenOf(new Map()), 'unconfigured').toBe(shifted);
      expect(capFenOf(capSnapshot(MALFORMED_CAPS[0])), 'malformed').toBe(shifted);
      expect(capFenOf(capSnapshot(VALID_CAPS[1])), 'valid').toBe(BigInt(VALID_CAPS[1]!));
    });
  } finally {
    await f.stop();
  }
}, 30_000);

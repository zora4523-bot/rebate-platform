// Shared fixture of the B1-31b runEntry-level tracing tests (entry.int / entry-failure.int). As in
// test/spec/platform/metrics/entry.test.ts, runEntry runs with spied platform exports: the
// configuration (loadConfig with APP_ENV=test, COULI_EXIT_AFTER_INIT=1 and the trace endpoint set to
// the loopback receiver), the database handles and the Nest application / worker context are
// stand-ins; tracing and its export are real. Dynamic imports keep Nest decorators out of the spec
// project's TypeScript compilation. Int tests only (the receiver opens a loopback port).
import { vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  AppConfig,
  DbHandles,
  MaintConnectionConfig,
  RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  ENDPOINT_VAR,
  ROOT,
  configOf,
  memoryLogger,
  otelApi,
  tracingFootprint,
  type LogRecord,
} from './kit.ts';

export type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';

/** The entries that export traces (05 B1-31); admin and payout never do. */
export const TRACED: readonly Entry[] = ['api', 'stream', 'worker'];
export const UNTRACED: readonly Entry[] = ['admin', 'payout'];

/** The span every stand-in records while the entry builds its application / worker context. */
export function buildSpanName(entry: Entry): string {
  return `b1-31b build ${entry}`;
}

/** The global part of the footprint: a recording tracer provider and a propagator. */
export function providerFootprint(): string[] {
  return tracingFootprint().filter(
    (item) => item === 'global tracer provider' || item.startsWith('global propagator'),
  );
}

interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

export type FailAt = 'none' | 'db-handles' | 'maint-handle';

export interface EntryFixture {
  readonly runEntry: (entry: Entry) => Promise<void>;
  readonly config: AppConfig;
  readonly logger: RootLogger;
  readonly records: () => LogRecord[];
  /** The messages logged so far, in order. */
  readonly messages: () => string[];
  /** tracingFootprint() as it was each time the entry built its application / worker context. */
  readonly atBuild: string[][];
  /** Calls of the stand-in database handles' close(). */
  readonly handlesClosed: () => number;
}

/**
 * Installs the stand-ins for one runEntry(entry) call. `failAt`: createDbHandles or (worker, with a
 * maintenance connection configured) createMaintDbHandle throws.
 */
export async function entryFixture(
  entry: Entry,
  endpoint: string,
  failAt: FailAt = 'none',
): Promise<EntryFixture> {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  // Everything real is computed before the spies are installed.
  const config = configOf({ [ENDPOINT_VAR]: endpoint, COULI_EXIT_AFTER_INIT: '1' });
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  const { logger, records } = memoryLogger(entry);
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);

  let closed = 0;
  vi.spyOn(platform, 'createDbHandles').mockImplementation(() => {
    if (failAt === 'db-handles') throw new Error('b1-31b: createDbHandles failed');
    const handles: DbHandles = {
      db: {} as DbHandles['db'],
      dbRead: null,
      close: async () => {
        closed += 1;
      },
    };
    return handles;
  });
  if (failAt === 'maint-handle') {
    vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue({
      name: 'dbMaint',
    } as unknown as MaintConnectionConfig);
    vi.spyOn(platform, 'createMaintDbHandle').mockImplementation(() => {
      throw new Error('b1-31b: createMaintDbHandle failed');
    });
  } else {
    vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  }

  const atBuild: string[][] = [];
  const observeBuild = (): void => {
    atBuild.push(tracingFootprint());
    otelApi().trace.getTracer('b1-31b').startSpan(buildSpanName(entry)).end();
  };
  const queue = { start: async () => undefined, stop: async () => undefined };
  const standIn = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
  };
  vi.spyOn(boot, 'createHttpApp').mockImplementation(async () => {
    observeBuild();
    return standIn;
  });
  vi.spyOn(boot, 'createWorkerContext').mockImplementation(async () => {
    observeBuild();
    return standIn;
  });

  return {
    runEntry,
    config,
    logger,
    records,
    messages: () => records().map((record) => String(record.msg)),
    atBuild,
    handlesClosed: () => closed,
  };
}

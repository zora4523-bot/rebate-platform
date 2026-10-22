import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, vi } from 'vitest';
import type { checkStagingDependencies } from '../../../../apps/api/src/modules/health/staging-dependencies.ts';
import { asset, list, record, services, string } from '../../infra/staging/kit.ts';

export type Entry = 'worker' | 'payout';
export type Probe = typeof checkStagingDependencies;
export type Fault = 'none' | 'pg-connect' | 'pg-query' | 'redis-connect' | 'redis-ping';

// Synthetic URLs only. No real environment, credential file, socket or subprocess is used.
export const DATABASE_URLS = {
  worker: 'postgres://couli_app@database.invalid:5433/staging',
  payout: 'postgres://couli_payout@database.invalid:5433/staging',
} as const;
export const REDIS_URL = 'redis://cache.invalid:6379/0';

function compile(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  expect(result.diagnostics ?? [], 'probe must compile without syntax errors').toEqual([]);
  return result.outputText;
}

/** Exercise the production module with pg/ioredis replaced at the driver boundary. */
export function dependencyProbe(fault: Fault = 'none') {
  const pgOptions: unknown[] = [];
  const redisOptions: unknown[][] = [];
  const queries: unknown[] = [];
  const pings: string[] = [];
  const connect = vi.fn(async () => {
    if (fault === 'pg-connect') throw new Error('synthetic PG connection failure');
  });
  class PgClient {
    constructor(options: unknown) {
      pgOptions.push(options);
    }
    connect = connect;
    async query(query: unknown) {
      queries.push(query);
      if (fault === 'pg-connect' || fault === 'pg-query') {
        throw new Error('synthetic PG query failure');
      }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    async end() {}
    on() {
      return this;
    }
  }
  class Redis {
    constructor(...options: unknown[]) {
      redisOptions.push(options);
    }
    async connect() {
      if (fault === 'redis-connect') throw new Error('synthetic Redis connection failure');
    }
    async ping() {
      pings.push('PING');
      if (fault === 'redis-connect' || fault === 'redis-ping') {
        throw new Error('synthetic Redis command failure');
      }
      return 'PONG';
    }
    async quit() {
      return 'OK';
    }
    disconnect() {}
    on() {
      return this;
    }
    once() {
      return this;
    }
  }
  const exports: Record<string, unknown> = {};
  runInNewContext(
    compile(asset('apps/api/src/modules/health/staging-dependencies.ts')),
    {
      exports,
      require(name: string) {
        if (name === 'pg') return { Client: PgClient, Pool: PgClient };
        if (name === 'ioredis') return Object.assign(Redis, { Redis });
        throw new Error(`Unexpected dependency in isolated health probe: ${name}`);
      },
      setTimeout,
      clearTimeout,
      AbortSignal,
      URL,
    },
    { timeout: 1000 },
  );
  expect(typeof exports['checkStagingDependencies']).toBe('function');
  return {
    check: exports['checkStagingDependencies'] as Probe,
    pgOptions,
    redisOptions,
    queries,
    pings,
  };
}

/**
 * Run the actual Compose inline Node command with synthetic /proc and start-marker reads.
 * The compiled module's public probe is replaced here to test wiring independently of drivers.
 * This preserves the current CMD/node/-e form and supports dynamic import and top-level await.
 */
export async function composeProbe(
  entry: Entry,
  dependenciesHealthy: boolean,
  state: { age: number; starts: number; settled: boolean } = {
    age: 60,
    starts: 1,
    settled: false,
  },
) {
  const health = record(record(services()[entry])['healthcheck']);
  expect(health['disable']).not.toBe(true);
  const args = list(health['test']).map(string);
  expect(args.slice(0, 2)).toEqual(['CMD', 'node']);
  const evalIndex = args.findIndex((arg) => arg === '-e' || arg === '--eval');
  expect(evalIndex, 'keep the one-shot Node health command').toBeGreaterThan(1);
  const code = string(args[evalIndex + 1]);
  const check = vi.fn<Probe>(async () => dependenciesHealthy);
  const fs = {
    readFileSync(path: string) {
      if (path === '/proc/uptime') return `${100 + state.age} 0`;
      if (path === '/proc/1/stat') {
        return `1 (node) ${[...Array<string>(19).fill('0'), '10000'].join(' ')}`;
      }
      if (path === '/tmp/couli-starts') return 'start\n'.repeat(state.starts);
      throw new Error(`Unexpected healthcheck file read: ${path}`);
    },
    existsSync(path: string) {
      expect(path).toBe('/tmp/couli-settled');
      return state.settled;
    },
  };
  const exited = Promise.withResolvers<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(-1), 1000);
  });
  try {
    const execution: unknown = runInNewContext(
      `(async () => { ${compile(code)} })()`,
      {
        exports: {},
        require(name: string) {
          if (name === 'node:fs' || name === 'fs') return fs;
          expect(name, 'Compose must invoke the built dependency probe').toMatch(
            /(?:^|\/)apps\/api\/dist\/modules\/health\/staging-dependencies\.js$/,
          );
          return { checkStagingDependencies: check };
        },
        process: {
          env: {
            DATABASE_URL: DATABASE_URLS[entry],
            ...(entry === 'worker' ? { REDIS_URL } : {}),
          },
          getBuiltinModule(name: string) {
            expect(name).toBe('node:fs');
            return fs;
          },
          exit(code: number) {
            exited.resolve(code);
          },
        },
        setTimeout,
        clearTimeout,
        AbortSignal,
      },
      { timeout: 1000 },
    );
    const status = await Promise.race([
      exited.promise,
      Promise.resolve(execution).then(() => exited.promise),
      deadline,
    ]);
    expect(status, 'health command must explicitly exit').not.toBe(-1);
    return { status, check };
  } finally {
    clearTimeout(timer);
  }
}

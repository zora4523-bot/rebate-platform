import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, vi } from 'vitest';
import { asset, record, string } from '../../infra/staging/kit.ts';
import type { Entry, Probe } from './kit.ts';

// Additive review fixtures: the first attempt's committed test assets remain unchanged.
// These are synthetic values. No certificate, environment file or socket is accessed.
export const CA_PATH = '/etc/pki/ca.crt';
const CA_CONTENT = 'synthetic-staging-ca';
export const TLS_DATABASE_URLS = {
  worker:
    'postgres://couli_app@database.invalid:5433/staging?sslmode=verify-ca&sslrootcert=/etc/pki/ca.crt',
  payout:
    'postgres://couli_payout@database.invalid:5433/staging?sslmode=verify-ca&sslrootcert=/etc/pki/ca.crt',
} as const;

export function compileProbe(source: string): string {
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

export function tlsDependencyProbe() {
  const pgOptions: unknown[] = [];
  const redisOptions: unknown[][] = [];
  const queries: unknown[] = [];
  const pings: string[] = [];
  const readCa = vi.fn((path: string, encoding?: string) => {
    expect(path).toBe(CA_PATH);
    return encoding === undefined ? Buffer.from(CA_CONTENT) : CA_CONTENT;
  });
  const fsPromises = {
    readFile: vi.fn(async (path: string, encoding?: string) => readCa(path, encoding)),
  };
  const fs = { readFileSync: readCa, promises: fsPromises };
  const tls = {
    // A CA-signed certificate with a different SAN must be accepted by verify-ca.
    checkServerIdentity: vi.fn(() => new Error('synthetic hostname mismatch')),
  };
  class PgClient {
    constructor(options: unknown) {
      pgOptions.push(options);
    }
    async connect() {}
    async query(query: unknown) {
      queries.push(query);
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
    async connect() {}
    async ping() {
      pings.push('PING');
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
  function isolatedRequire(name: string): unknown {
    if (name === 'pg') return { Client: PgClient, Pool: PgClient };
    if (name === 'ioredis') return Object.assign(Redis, { Redis });
    if (name === 'node:fs' || name === 'fs') return fs;
    if (name === 'node:fs/promises' || name === 'fs/promises') return fsPromises;
    if (name === 'node:tls' || name === 'tls') return tls;
    throw new Error(`Unexpected dependency in isolated TLS probe: ${name}`);
  }
  const exports: Record<string, unknown> = {};
  runInNewContext(
    compileProbe(asset('apps/api/src/modules/health/staging-dependencies.ts')),
    {
      exports,
      require: isolatedRequire,
      process: { getBuiltinModule: isolatedRequire },
      URL,
      Buffer,
      AbortSignal,
      setTimeout,
      clearTimeout,
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
    readCa,
  };
}

/** Assert effective TLS semantics, including pg's connection-string override hazard. */
export function expectVerifyCa(options: unknown, entry: Entry): void {
  const config = record(options);
  const expected = new URL(TLS_DATABASE_URLS[entry]);
  const connectionString = config['connectionString'];
  let url: URL | undefined;
  if (connectionString !== undefined) {
    url = new URL(string(connectionString));
    expect(url.hostname).toBe(expected.hostname);
    expect(url.port).toBe(expected.port);
    expect(url.username).toBe(expected.username);
    expect(url.pathname).toBe(expected.pathname);
  } else {
    expect(config['host']).toBe(expected.hostname);
    expect(Number(config['port'])).toBe(Number(expected.port));
    expect(config['user']).toBe(expected.username);
    expect(config['database']).toBe(expected.pathname.slice(1));
  }
  if (url?.searchParams.has('sslmode')) {
    // pg reparses SSL query parameters and overrides config.ssl. A callback on config.ssl
    // alone is insufficient if the original verify-ca string is still passed through.
    expect(url.searchParams.get('sslmode')).toBe('verify-ca');
    expect(url.searchParams.get('sslrootcert')).toBe(CA_PATH);
    expect(url.searchParams.get('uselibpqcompat'), 'pg must retain verify-ca semantics').toBe(
      'true',
    );
    return;
  }
  for (const key of ['ssl', 'sslrootcert', 'sslcert', 'sslkey']) {
    expect(
      url?.searchParams.has(key) ?? false,
      `${key} must not override explicit TLS options`,
    ).toBe(false);
  }
  const ssl = record(config['ssl']);
  expect(ssl['rejectUnauthorized'], 'verify-ca must still validate the certificate chain').not.toBe(
    false,
  );
  expect(String(ssl['ca'])).toBe(CA_CONTENT);
  expect(typeof ssl['checkServerIdentity']).toBe('function');
  const checkIdentity = ssl['checkServerIdentity'] as (host: string, cert: unknown) => unknown;
  expect(
    checkIdentity(expected.hostname, { subjectaltname: 'DNS:different.invalid' }),
  ).toBeUndefined();
}

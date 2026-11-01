import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  ConfigError,
  loadConfig,
  type AppConfig,
  type AppEnv,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import type {
  CallCtx,
  UnionEndpoint,
  UnionMode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import * as http from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import * as taobao from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  PRIVILEGE_PATH,
  envelope as privilegeEnvelope,
  privilegeData,
} from '../taobao-convert/kit.ts';
import { ORDER_PATH, pageData, reply as orderReply } from '../taobao-orders/kit.ts';
import {
  DETAIL,
  SEARCH_PATH,
  convertAll,
  dataokeEnvelope,
  dtkRow,
  formOf,
  response,
  searchData,
  topError,
  truthfulTop,
} from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zn#n]) refer to the B1-04zn ledger (D10-530). Everything is
// synthetic: credentials are low-entropy strings, the secret file paths are never opened (the
// credential openers are stubbed by the wiring test), the upstream answers reuse the synthetic
// fixtures of B1-04zh (search), B1-04d (convert) and B1-04f (orders). No network, no database,
// no listening port.

export const CONVERT_VARIABLE = 'TAOBAO_CONVERT_SOURCE';
export const SEARCH_VARIABLE = 'TAOBAO_SEARCH_SOURCE';
export const TAOBAO_APP_KEY = 'fake-switches-taobao-key';
export const TAOBAO_SECRET = 'swit-swit-swit-swit-swit';
export const DATAOKE_APP_KEY = 'fake-switches-dataoke-key';
export const DATAOKE_SECRET = 'dtks-dtks-dtks-dtks-dtks';
export const TAOBAO_SECRET_PATH = '/FAKE_SWITCHES_TAOBAO_PATH/secret.txt';
export const DATAOKE_SECRET_PATH = '/FAKE_SWITCHES_DATAOKE_PATH/secret.txt';
export const TAOBAO_URL = 'https://taobao-switches.invalid/router/rest';
/** The fixed 大淘客 gateway the union module wires (B1-04e). */
export const DATAOKE_GATEWAY = 'https://openapi.dataoke.com';
/** A synthetic gateway for registry-level tests (the registry uses the one it is given). */
export const SYNTHETIC_GATEWAY = 'https://dataoke-switches.invalid';

export const APP = 'synthetic-switches-app-a';
export const OTHER_APP = 'synthetic-switches-app-b';
export const clock = new FixedClock('2026-11-01T06:00:00.000Z');
export const ctx: CallCtx = {
  appId: APP,
  requestId: 'synthetic-switches-request',
  purpose: 'order_sync',
};
export const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** B3-09j: loadConfig requires AGENT_USER_HASH_KEY when APP_ENV=prod; synthetic test-only value. */
export const PROD_AGENT_KEY = {
  AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-taobao-switches',
};

/** A loadable base environment for `appEnv` (staging / prod need the KMS keyring names). */
export function environment(appEnv: AppEnv): Record<string, string> {
  return {
    APP_ENV: appEnv,
    ...(appEnv === 'staging' || appEnv === 'prod'
      ? {
          FIELD_KEY_PROVIDER: 'kms',
          FIELD_KEYRING_FILE: join(root, '.tmp/unused-keyring.json'),
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: join(root, '.tmp/unused-prior-identity-keyring.json'),
        }
      : {}),
    ...(appEnv === 'prod' ? PROD_AGENT_KEY : {}),
  };
}

/**
 * staging with both taobao variables, both 大淘客 variables unless `dataoke` is false, and any
 * extra variables (the switches).
 */
export function configured(extra: Record<string, string> = {}, dataoke = true): AppConfig {
  return loadConfig({
    ...environment('staging'),
    TAOBAO_APP_KEY,
    TAOBAO_APP_SECRET_FILE: TAOBAO_SECRET_PATH,
    ...(dataoke ? { DATAOKE_APP_KEY, DATAOKE_APP_SECRET_FILE: DATAOKE_SECRET_PATH } : {}),
    ...extra,
  });
}

export function configFailure(env: Readonly<Record<string, string | undefined>>): ConfigError {
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    if (isHarnessError(error)) throw error;
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

/** taobao gets `mode`; pdd stays replay (no pdd credential); jd live stays unconfigured. */
export function endpoints(mode: UnionMode = 'live'): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => {
    const chosen: UnionMode = platform === 'taobao' ? mode : platform === 'pdd' ? 'replay' : 'live';
    return {
      platform,
      mode: chosen,
      baseUrl:
        chosen === 'demo'
          ? null
          : platform === 'taobao'
            ? TAOBAO_URL
            : `https://${platform}-switches.invalid/router`,
      quotaKey: `fake-switches:${platform}`,
    };
  });
}

export function visible(value: unknown): string {
  const replacer = (_key: string, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member;
  return `${String(value)}\n${JSON.stringify(value, replacer)}\n${inspect(value, { depth: null })}`;
}

/** A harness / import / programming error, or the skeleton's NotImplemented: a red of its own. */
export function isHarnessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (['AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(
      error.name,
    ) ||
      /\bNotImplemented\b/.test(`${error.name} ${error.message}`) ||
      ('code' in error && error.code === 'ERR_MODULE_NOT_FOUND'))
  );
}

/** What a call resolves to, or the business error it rejects with (harness errors rethrown). */
export async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (isHarnessError(error)) throw error;
    return error;
  }
}

/** A call that must succeed: a rejection fails as an assertion. */
export async function succeeded<T>(run: () => Promise<T>, label: string): Promise<T> {
  const result = await outcome(run);
  expect(result, `${label} must succeed`).not.toBeInstanceOf(Error);
  return result as T;
}

/** A call that must reject with the union error `code` (platform taobao). */
export async function refused(run: () => unknown, code: string): Promise<void> {
  const result = await outcome(run);
  expect(result).toBeInstanceOf(Error);
  expect(result).toMatchObject({ code, platform: 'taobao' });
}

/** Observe construction without replacing the real TaobaoUnionAdapter. */
export function observeTaobao() {
  const Original = taobao.TaobaoUnionAdapter;
  return vi.spyOn(taobao, 'TaobaoUnionAdapter').mockImplementation(class extends Original {});
}

// ---------------------------------------------------------------------------------------------
// Upstream fakes
// ---------------------------------------------------------------------------------------------

export interface UpstreamOptions {
  /** The 大淘客 order page rows (B1-04f fixtures). */
  readonly orders?: readonly unknown[];
}

/**
 * In-memory upstreams: `dataokeTransport` answers the 大淘客 paths (search two synthetic goods,
 * privilege link, one order page), `topTransport` the TOP item detail that converts goodsIds.
 * `combined` routes by path (大淘客 paths start with /api/) for a module that wires one HTTPS
 * transport factory for both.
 */
export function fakeUpstream(options: UpstreamOptions = {}) {
  const dataokeTransport = vi.fn<UnionTransport>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === SEARCH_PATH) {
      return response(dataokeEnvelope(searchData([dtkRow(1), dtkRow(2)], 2)));
    }
    if (path === PRIVILEGE_PATH) return response(privilegeEnvelope(privilegeData()));
    if (path === ORDER_PATH) return orderReply(pageData(options.orders ?? []));
    return response({ time: 1_793_500_000_000, code: -1, msg: 'synthetic unexpected path' });
  });
  const topTransport = vi.fn<UnionTransport>(async (request) => {
    const form = formOf(request);
    if (form['method'] !== DETAIL) return response(topError('synthetic-unexpected-method'));
    return response(truthfulTop((form['item_id'] ?? '').split(','), convertAll));
  });
  const combined: UnionTransport = (request: UnionTransportRequest) =>
    new URL(request.url).pathname.startsWith('/api/')
      ? dataokeTransport(request)
      : topTransport(request);
  return { dataokeTransport, topTransport, combined };
}

export type Upstream = ReturnType<typeof fakeUpstream>;

/** The union module's HTTPS transports all become the fake upstream. */
export function stubHttp(upstream: Upstream): void {
  vi.spyOn(http, 'createUnionHttpTransport').mockReturnValue(upstream.combined);
}

/** Paths of the 大淘客 requests so far. */
export function dataokePaths(upstream: Upstream): string[] {
  return upstream.dataokeTransport.mock.calls.map(([request]) => new URL(request.url).pathname);
}

// ---------------------------------------------------------------------------------------------
// union_pids in memory
// ---------------------------------------------------------------------------------------------

export interface PidRow {
  id: string;
  app_id: string;
  platform: string;
  union_account_id: string;
  site_id: string | null;
  pid: string;
  pid_scene: string;
  status: string;
}

let pidSequence = 0;

export function pidRow(overrides: Partial<PidRow> = {}): PidRow {
  pidSequence += 1;
  const platform = overrides.platform ?? 'taobao';
  return {
    id: `00000000-0000-4000-8000-${String(pidSequence).padStart(12, '0')}`,
    app_id: APP,
    platform,
    union_account_id: '00000000-0000-4000-8000-0000000000aa',
    site_id: platform === 'taobao' ? '3000000001' : null,
    pid: `mm_1000000001_3000000001_${String(123456700000 + pidSequence)}`,
    pid_scene: 'self_buy',
    status: 'active',
    ...overrides,
  };
}

/** The value bound to `"column" = $n`; fails when the statement has no such equality. */
export function equality(statement: CompiledQuery, column: string): unknown {
  const match = new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`).exec(statement.sql);
  expect(match, `missing equality for ${column}`).not.toBeNull();
  return statement.parameters[Number(match![1]) - 1];
}

/**
 * Real Kysely compilation over an in-memory union_pids. Reads must be one SELECT of
 * app.union_pids bound by app_id and platform, never filtered by status or scene; the B1-04p
 * archive insert (union_raw_payloads) is recorded apart; anything else fails.
 */
export function pidDatabase(initial: readonly PidRow[] = []) {
  let rows: readonly PidRow[] = initial;
  let failure: Error | null = null;
  const statements: CompiledQuery[] = [];
  const archived: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      if (/^insert into "app"\."union_raw_payloads"/i.test(statement.sql)) {
        archived.push(statement);
        return { rows: [{ id: BigInt(archived.length) }] as R[], numAffectedRows: 1n };
      }
      statements.push(statement);
      expect(statement.sql).toMatch(/^select\b/i);
      expect(statement.sql).toContain('"app"."union_pids"');
      expect(statement.sql).not.toMatch(/\b(insert|update|delete|for update)\b/i);
      expect(statement.sql, 'the slot reader filters by neither status nor scene').not.toMatch(
        /"status"|"pid_scene"/,
      );
      const appId = equality(statement, 'app_id');
      const platform = equality(statement, 'platform');
      if (failure !== null) throw failure;
      return {
        rows: rows.filter((row) => row.app_id === appId && row.platform === platform) as R[],
      };
    },
    async *streamQuery() {
      expect.fail('the slot reader must not stream rows');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    db,
    statements,
    archived,
    replace(next: readonly PidRow[]) {
      rows = next;
    },
    /** Every following read throws `error` (after it was checked). */
    fail(error: Error) {
      failure = error;
    },
  };
}

export type PidDatabase = ReturnType<typeof pidDatabase>;

// ---------------------------------------------------------------------------------------------
// Nest assembly of UnionModule
// ---------------------------------------------------------------------------------------------

/** One log call of the assembled module: its level, its arguments and everything it would print. */
export interface LogEntry {
  readonly level: string;
  readonly args: readonly unknown[];
  readonly text: string;
}

export function logText(logs: readonly LogEntry[]): string {
  return logs.map((entry) => `${entry.level} ${entry.text}`).join('\n');
}

interface FactoryProvider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...args: unknown[]) => unknown;
}
interface ModuleMetadata {
  module: unknown;
  providers: FactoryProvider[];
  exports?: unknown[];
}
interface ModuleExports {
  UNION_ENDPOINTS: unknown;
  UNION_REGISTRY: unknown;
  UnionModule: { forRoot(): ModuleMetadata };
}
interface TestContext {
  get<T>(token: unknown): T;
  init(): Promise<unknown>;
  close(): Promise<void>;
}
interface NestTesting {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): {
      compile(): Promise<TestContext>;
    };
  };
}

/**
 * Full Nest dependency resolution of UnionModule.forRoot() (no application, no port), with the
 * given config, the fixed clock, a recording root logger and, when given, the database handle as
 * the DB token. The endpoint set replaces the file-loading UNION_ENDPOINTS provider. Dynamic
 * imports keep the module's decorators out of the test type check (as the frozen wiring tests).
 */
export async function assemble(
  config: AppConfig,
  options: { readonly db?: Kysely<DB>; readonly endpoints?: readonly UnionEndpoint[] } = {},
): Promise<{
  readonly registry: UnionRegistry;
  readonly logs: LogEntry[];
  close(): Promise<void>;
}> {
  const modulePath = '../../../../apps/api/src/modules/union/union.module.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as ModuleExports;
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    /* @vite-ignore */ pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as NestTesting;
  const logs: LogEntry[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push({ level, args, text: visible(args) });
    };
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  const values = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  if (options.db !== undefined) values.set(platform['DB'], options.db);
  class FixtureGlobals {}
  const metadata = union.UnionModule.forRoot();
  const configuredEndpoints = options.endpoints ?? endpoints();
  const compiled = await outcome(() =>
    testing.Test.createTestingModule({
      imports: [
        {
          module: FixtureGlobals,
          global: true,
          providers: [...values].map(([provide, useValue]) => ({ provide, useValue })),
          exports: [...values.keys()],
        },
        {
          ...metadata,
          providers: metadata.providers.map((provider) =>
            provider.provide === union.UNION_ENDPOINTS
              ? { provide: provider.provide, useValue: configuredEndpoints }
              : provider,
          ),
        },
      ],
    }).compile(),
  );
  expect(compiled, 'the union module must start').not.toBeInstanceOf(Error);
  const context = compiled as TestContext;
  const initialized = await outcome(() => context.init());
  expect(initialized, 'the union module must start').not.toBeInstanceOf(Error);
  return {
    registry: context.get<UnionRegistry>(union.UNION_REGISTRY),
    logs,
    close: () => context.close(),
  };
}

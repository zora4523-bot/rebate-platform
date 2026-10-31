import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import * as jd from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';

// Task-local AC labels ([AC-B1-04ze#n]) refer to the B1-04ze ledger (the jd mirror of B1-04k's
// taobao-live-wiring). All values are synthetic, low-entropy strings. No real account, gateway or
// credential is used.
export const APP_KEY = 'fake-jd-app-key';
export const SECRET = 'plain-plain-plain-plain';
export const OTHER_SECRET = 'other-other-other-other';
export const PDD_CLIENT_ID = 'fake-pdd-client-id';
export const PDD_SECRET = 'pdd-pdd-pdd-pdd-pdd';
export const TAOBAO_APP_KEY = 'fake-taobao-app-key';
export const TAOBAO_SECRET = 'tbk-tbk-tbk-tbk-tbk';
export const JD_URL = 'https://jd.invalid/routerjson';
export const clock = new FixedClock('2026-10-31T08:00:00.000Z');
export const context: CallCtx = {
  appId: 'fake-jd-wiring-app',
  requestId: 'fake-jd-wiring-request',
  purpose: 'online',
};
export const root = fileURLToPath(new URL('../../../../', import.meta.url));

// B3-09j: loadConfig requires AGENT_USER_HASH_KEY when APP_ENV=prod; synthetic test-only value.
export const PROD_AGENT_KEY = {
  AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-jd-live-wiring',
};

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
  };
}

/** staging with both jd variables (plus any extra variables, e.g. the pdd and taobao pairs). */
export function configured(file: string, extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...environment('staging'),
    JD_APP_KEY: APP_KEY,
    JD_APP_SECRET_FILE: file,
    ...extra,
  });
}

/**
 * jd gets `mode`; pdd and taobao get `others` (replay by default, so no credential of theirs is
 * involved and their own refusals never decide a jd test).
 */
export function endpoints(
  mode: UnionMode = 'live',
  others: UnionMode = 'replay',
): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => {
    const chosen: UnionMode = platform === 'jd' ? mode : others;
    return {
      platform,
      mode: chosen,
      baseUrl:
        chosen === 'demo'
          ? null
          : platform === 'jd'
            ? JD_URL
            : `https://${platform}.invalid/router`,
      quotaKey: `fake-jd-wiring:${platform}`,
    };
  });
}

export function registryOptions(mode: UnionMode = 'live', appEnv: AppEnv = 'staging') {
  return { endpoints: endpoints(mode), environment: appEnv, seed: 'fake-jd-wiring', clock };
}

export async function temporaryDirectory(): Promise<string> {
  const parent = join(root, '.tmp/jd-live-wiring');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'case-'));
}

export async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function visible(value: unknown): string {
  return `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
}

export function configFailure(env: Readonly<Record<string, string | undefined>>): ConfigError {
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

export async function startupFailure(run: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    // A harness/import/programming error, or the skeleton's NotImplemented, must stay a red of its
    // own, never pass as a startup refusal.
    if (
      error instanceof Error &&
      (['AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(
        error.name,
      ) ||
        /\bNotImplemented\b/.test(error.message) ||
        ('code' in error && error.code === 'ERR_MODULE_NOT_FOUND'))
    ) {
      throw error;
    }
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(TypeError);
  return caught as Error;
}

/** Observe construction without replacing the real B1-04za constructor or request method. */
export function observeJd() {
  const Original = jd.JdUnionAdapter;
  const constructor = vi.spyOn(jd, 'JdUnionAdapter').mockImplementation(class extends Original {});
  return { constructor };
}

/** One log call of the startup harness: its level and everything it would print. */
export interface LogEntry {
  readonly level: string;
  readonly text: string;
}

export function logText(logs: readonly LogEntry[]): string {
  return logs.map((entry) => `${entry.level} ${entry.text}`).join('\n');
}

/** The configuration port of UnionModule.forRoot: `{ value, version }` or null per key. */
export interface ConfigReader {
  configValue(appId: string, key: string): Promise<unknown>;
}

export interface UnionModuleOptions {
  readonly config?: (db: never, clock: never) => ConfigReader;
}

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

interface UnionModuleExports {
  readonly UNION_ENDPOINTS: unknown;
  readonly UNION_REGISTRY: unknown;
  readonly UnionModule: {
    forRoot(directory?: string, options?: UnionModuleOptions): { providers: readonly unknown[] };
  };
}

function isFactory(value: unknown): value is FactoryProvider {
  return typeof value === 'object' && value !== null && 'useFactory' in value;
}

function dependency(entry: unknown, values: ReadonlyMap<unknown, unknown>): unknown {
  // Nest's optional form: without a value the factory gets undefined.
  if (typeof entry === 'object' && entry !== null && 'token' in entry) {
    return values.get(entry.token);
  }
  expect(values.has(entry), 'factory dependency must be supplied by the startup harness').toBe(
    true,
  );
  return values.get(entry);
}

/**
 * Execute the actual registered startup factories, with the same injected values as Nest.
 * No full platform bootstrap: that would open unrelated KMS, DB and JWT providers.
 * Dynamic import follows the existing wiring tests to keep decorators out of test tsc.
 * `db` (any stand-in object) is what the optional-DB providers receive; without it no database is
 * present. `options` is the second argument of forRoot. The module's other providers run first,
 * whatever they are called: they fill what the live adapter reads per call.
 */
export async function startUnion(
  config: AppConfig,
  configuredEndpoints: readonly UnionEndpoint[],
  logs: LogEntry[] = [],
  db?: unknown,
  options?: UnionModuleOptions,
): Promise<UnionRegistry> {
  const modulePath = '../../../../apps/api/src/modules/union/union.module.ts';
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as UnionModuleExports;
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      logs.push({ level, text: visible(args) });
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
    [union.UNION_ENDPOINTS, configuredEndpoints],
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  if (db !== undefined) values.set(platform['DB'], db);
  const { providers } =
    options === undefined
      ? union.UnionModule.forRoot()
      : union.UnionModule.forRoot(undefined, options);
  for (const value of providers) {
    if (!isFactory(value)) continue;
    if (value.provide === union.UNION_ENDPOINTS || value.provide === union.UNION_REGISTRY) continue;
    const args = (value.inject ?? []).map((entry) => dependency(entry, values));
    values.set(value.provide, await value.useFactory(...args));
  }
  const provider = providers
    .filter(isFactory)
    .find((value) => value.provide === union.UNION_REGISTRY);
  expect(provider).toBeDefined();
  expect(provider?.useFactory).toBeTypeOf('function');
  const args = (provider!.inject ?? []).map((entry) => dependency(entry, values));
  return (await provider!.useFactory(...args)) as UnionRegistry;
}

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
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import * as taobao from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels refer to the B1-04k ledger (mirror of B1-04t's pdd-live-wiring).
// All values are synthetic, low-entropy strings. No real account, gateway or credential is used.
export const APP_KEY = 'fake-taobao-app-key';
export const SECRET = 'plain-plain-plain-plain';
export const OTHER_SECRET = 'other-other-other-other';
export const PDD_CLIENT_ID = 'fake-pdd-client-id';
export const PDD_SECRET = 'pdd-pdd-pdd-pdd-pdd';
export const TAOBAO_URL = 'https://taobao.invalid/router/rest';
export const clock = new FixedClock('2026-10-31T08:00:00.000Z');
export const context: CallCtx = {
  appId: 'fake-taobao-wiring-app',
  requestId: 'fake-taobao-wiring-request',
  purpose: 'online',
};
export const root = fileURLToPath(new URL('../../../../', import.meta.url));

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

/** staging with both taobao variables (plus any extra variables, e.g. the pdd pair). */
export function configured(file: string, extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...environment('staging'),
    TAOBAO_APP_KEY: APP_KEY,
    TAOBAO_APP_SECRET_FILE: file,
    ...extra,
  });
}

/**
 * taobao gets `mode`; pdd gets `pdd` (replay by default, so no pdd credential is involved and pdd's
 * own refusals never decide a taobao test); jd stays live (unimplemented, never refused).
 */
export function endpoints(
  mode: UnionMode = 'live',
  pdd: UnionMode = 'replay',
): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => {
    const chosen: UnionMode = platform === 'taobao' ? mode : platform === 'pdd' ? pdd : 'live';
    return {
      platform,
      mode: chosen,
      baseUrl:
        chosen === 'demo'
          ? null
          : platform === 'taobao'
            ? TAOBAO_URL
            : `https://${platform}.invalid/router`,
      quotaKey: `fake-taobao-wiring:${platform}`,
    };
  });
}

export function registryOptions(mode: UnionMode = 'live', appEnv: AppEnv = 'staging') {
  return { endpoints: endpoints(mode), environment: appEnv, seed: 'fake-taobao-wiring', clock };
}

export async function temporaryDirectory(): Promise<string> {
  const parent = join(root, '.tmp/taobao-live-wiring');
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

/** Observe construction without replacing the real B1-04j constructor or request method. */
export function observeTaobao() {
  const Original = taobao.TaobaoUnionAdapter;
  const constructor = vi
    .spyOn(taobao, 'TaobaoUnionAdapter')
    .mockImplementation(class extends Original {});
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

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

interface UnionModuleExports {
  readonly UNION_ENDPOINTS: unknown;
  readonly UNION_REGISTRY: unknown;
  readonly UNION_QUERY_PID_SOURCE: unknown;
  readonly UnionModule: { forRoot(): { providers: readonly unknown[] } };
}

function factoryFor(providers: readonly unknown[], token: unknown): FactoryProvider | undefined {
  return providers.find(
    (value): value is FactoryProvider =>
      typeof value === 'object' && value !== null && 'provide' in value && value.provide === token,
  );
}

/**
 * Execute the actual registered startup factory, with the same injected values as Nest.
 * No full platform bootstrap: that would open unrelated KMS, DB and JWT providers.
 * Dynamic import follows the existing wiring tests to keep decorators out of test tsc.
 * `db` (any stand-in object) is handed to the optional-DB provider the live transports archive
 * through (B1-04p); without it no database is present.
 */
export async function startUnion(
  config: AppConfig,
  configuredEndpoints: readonly UnionEndpoint[],
  logs: LogEntry[] = [],
  db?: unknown,
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
  const dependencies = new Map<unknown, unknown>([
    [union.UNION_ENDPOINTS, configuredEndpoints],
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  const providers = union.UnionModule.forRoot().providers;
  if (db !== undefined) {
    const source = factoryFor(providers, union.UNION_QUERY_PID_SOURCE);
    expect(source?.useFactory).toBeTypeOf('function');
    source!.useFactory(db);
  }
  const provider = factoryFor(providers, union.UNION_REGISTRY);
  expect(provider).toBeDefined();
  expect(provider?.useFactory).toBeTypeOf('function');
  const args = provider!.inject.map((token) => {
    expect(
      dependencies.has(token),
      'factory dependency must be supplied by the startup harness',
    ).toBe(true);
    return dependencies.get(token);
  });
  return (await provider!.useFactory(...args)) as UnionRegistry;
}

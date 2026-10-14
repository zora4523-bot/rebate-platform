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
import * as pdd from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';

// Task-local AC labels refer to the B1-04t ledger, not additional business rules.
// All values are synthetic. No actual node mount, account, gateway or credential is used.
export const CLIENT_ID = 'FAKE_PDD_CLIENT_ID';
export const SECRET = 'FAKE_PDD_SECRET_NOT_A_REAL_CREDENTIAL';
export const OTHER_SECRET = 'FAKE_PDD_REPLACEMENT_SECRET';
export const clock = new FixedClock('2026-10-14T08:00:00.000Z');
export const context: CallCtx = {
  appId: 'fake-wiring-app',
  requestId: 'fake-wiring-request',
  purpose: 'online',
};
export const root = fileURLToPath(new URL('../../../../', import.meta.url));

export function environment(appEnv: AppEnv): Record<string, string> {
  return {
    APP_ENV: appEnv,
    ...(appEnv === 'staging' || appEnv === 'prod'
      ? { FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: join(root, '.tmp/unused-keyring.json') }
      : {}),
  };
}

export function configured(file: string): AppConfig {
  return loadConfig({
    ...environment('staging'),
    PDD_CLIENT_ID: CLIENT_ID,
    PDD_CLIENT_SECRET_FILE: file,
  });
}

export function endpoints(mode: UnionMode = 'live'): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
    platform,
    mode: platform === 'pdd' ? mode : 'live',
    baseUrl: platform === 'pdd' && mode === 'demo' ? null : `https://${platform}.invalid/router`,
    quotaKey: `fake-wiring:${platform}`,
  }));
}

export function registryOptions(mode: UnionMode = 'live', appEnv: AppEnv = 'staging') {
  return { endpoints: endpoints(mode), environment: appEnv, seed: 'fake-wiring', clock };
}

export async function temporaryDirectory(): Promise<string> {
  const parent = join(root, '.tmp/pdd-live-wiring');
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
    // A harness/import/programming error must remain an invalid red, never a startup rejection.
    if (
      error instanceof Error &&
      (['AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(
        error.name,
      ) ||
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

/** Observe construction without replacing the real B1-04g constructor or request method. */
export function observePdd() {
  const Original = pdd.PddUnionAdapter;
  const constructor = vi
    .spyOn(pdd, 'PddUnionAdapter')
    .mockImplementation(class extends Original {});
  // Port mapping is a later task. A domain-only stub observes direct adapter delegation.
  const search = vi
    .spyOn(Original.prototype, 'searchItems')
    .mockResolvedValue({ items: [], nextCursor: null });
  return { constructor, search };
}

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

interface UnionModuleExports {
  readonly UNION_ENDPOINTS: unknown;
  readonly UNION_REGISTRY: unknown;
  readonly UnionModule: { forRoot(): { providers: readonly unknown[] } };
}

/**
 * Execute the actual registered startup factory, with the same injected values as Nest.
 * No full platform bootstrap: that would open unrelated KMS, DB and JWT providers.
 * Dynamic import follows the existing wiring-nest tests to keep decorators out of test tsc.
 */
export async function startUnion(
  config: AppConfig,
  configuredEndpoints: readonly UnionEndpoint[],
  logs: string[] = [],
): Promise<UnionRegistry> {
  const modulePath = '../../../../apps/api/src/modules/union/union.module.ts';
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as UnionModuleExports;
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const logger = {
    trace: (...args: unknown[]) => logs.push(visible(args)),
    debug: (...args: unknown[]) => logs.push(visible(args)),
    info: (...args: unknown[]) => logs.push(visible(args)),
    warn: (...args: unknown[]) => logs.push(visible(args)),
    error: (...args: unknown[]) => logs.push(visible(args)),
    fatal: (...args: unknown[]) => logs.push(visible(args)),
    child: () => logger,
  };
  const dependencies = new Map<unknown, unknown>([
    [union.UNION_ENDPOINTS, configuredEndpoints],
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  const provider = union.UnionModule.forRoot().providers.find(
    (value): value is FactoryProvider =>
      typeof value === 'object' &&
      value !== null &&
      'provide' in value &&
      value.provide === union.UNION_REGISTRY,
  );
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

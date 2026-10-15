import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  loadConfig,
  type AppConfig,
  type AppEnv,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { UnionEndpoint } from '../../../../apps/api/src/modules/union/domain/types.ts';

// AC-B1-04y labels refer only to this task's ledger excerpt (refs is empty).
// No node environment/credential files are read; fixtures live under the worktree's .tmp.
export const VARIABLE = 'UNION_ENDPOINT_OVERRIDE_DIR';
export const PLATFORMS = ['jd', 'pdd', 'taobao'] as const;
export const root = fileURLToPath(new URL('../../../../', import.meta.url));
export type OverrideConfig = AppConfig & { readonly unionEndpointOverrideDir?: string | null };

export function environment(appEnv: AppEnv): Record<string, string> {
  return {
    APP_ENV: appEnv,
    ...(appEnv === 'staging' || appEnv === 'prod'
      ? { FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: join(root, '.tmp/unused-keyring.json') }
      : {}),
  };
}

/** Business rejection becomes a value before assertions; harness failures must stay visible. */
export async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      (['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AssertionError'].includes(
        error.name,
      ) ||
        ('code' in error && error.code === 'ERR_MODULE_NOT_FOUND'))
    ) {
      throw error;
    }
    return error;
  }
}

export function configured(directory: string): AppConfig {
  return loadConfig({ ...environment('staging'), [VARIABLE]: directory });
}

export function demoEndpoints(): readonly UnionEndpoint[] {
  return PLATFORMS.map((platform) => ({
    platform,
    mode: 'demo',
    baseUrl: null,
    quotaKey: `synthetic-node-override:${platform}`,
  }));
}

export async function writeEndpoints(
  directory: string,
  endpoints: readonly UnionEndpoint[] = demoEndpoints(),
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const endpoint of endpoints) {
    await writeFile(join(directory, `${endpoint.platform}.json`), JSON.stringify(endpoint));
  }
}

export async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const parent = join(root, '.tmp/staging-pdd');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

interface UnionExports {
  readonly UNION_ENDPOINTS: unknown;
  readonly UNION_REGISTRY: unknown;
  readonly UnionModule: { forRoot(directory?: string): { providers: readonly unknown[] } };
}

/** Execute the actual registered factory; no Nest bootstrap, database, KMS or HTTP transport. */
export async function endpointFactory(directory?: string) {
  // Match existing Nest wiring tests: dynamic import keeps decorators out of test tsc.
  const unionPath = '../../../../apps/api/src/modules/union/union.module.ts';
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(unionPath, import.meta.url).href
  )) as UnionExports;
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const providers = union.UnionModule.forRoot(directory).providers;
  const find = (token: unknown): FactoryProvider => {
    const provider = providers.find(
      (value): value is FactoryProvider =>
        typeof value === 'object' &&
        value !== null &&
        'provide' in value &&
        value.provide === token,
    );
    expect(provider).toBeDefined();
    expect(provider?.useFactory).toBeTypeOf('function');
    return provider!;
  };
  const endpoints = find(union.UNION_ENDPOINTS);
  expect(endpoints.inject).toEqual([platform['APP_CONFIG']]);
  expect(find(union.UNION_REGISTRY).inject).toEqual([
    union.UNION_ENDPOINTS,
    platform['APP_CONFIG'],
    platform['CLOCK'],
    platform['ROOT_LOGGER'],
  ]);
  return (config: AppConfig): Promise<unknown> => outcome(() => endpoints.useFactory(config));
}

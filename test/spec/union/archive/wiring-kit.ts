import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import type { Clock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import { configured, endpoints } from '../pdd-live-wiring/kit.ts';
import { outcome } from './kit.ts';

interface Provider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...args: unknown[]) => unknown;
}
interface Metadata {
  module: unknown;
  providers: Provider[];
  exports?: unknown[];
}
interface ModuleExports {
  UNION_ENDPOINTS: unknown;
  UNION_REGISTRY: unknown;
  UnionModule: { forRoot(): Metadata };
}
interface TestContext {
  get<T>(injection: unknown): T;
  init(): Promise<unknown>;
  close(): Promise<void>;
}
interface Testing {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): { compile(): Promise<TestContext> };
  };
}

// Real Nest factories and optional DB injection. No app bootstrap, listeners or credentials.
export async function assemble(clock: Clock, db?: Kysely<DB>, mode: 'live' | 'demo' = 'live') {
  const union = (await import(
    new URL('../../../../apps/api/src/modules/union/union.module.ts', import.meta.url).href
  )) as ModuleExports;
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as Testing;
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  const values = new Map<unknown, unknown>([
    [
      platform['APP_CONFIG'],
      { ...configured('synthetic-unused-file'), pddQueryCustomParameters: '{"uid":"fake-query"}' },
    ],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  if (db !== undefined) values.set(platform['DB'], db);
  class FixtureGlobals {}
  const metadata = union.UnionModule.forRoot();
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
              ? { provide: provider.provide, useValue: endpoints(mode) }
              : provider,
          ),
        },
      ],
    }).compile(),
  );
  expect(compiled).not.toBeInstanceOf(Error);
  const context = compiled as TestContext;
  try {
    expect(await outcome(() => context.init())).not.toBeInstanceOf(Error);
    return { context, logger, registry: context.get<UnionRegistry>(union.UNION_REGISTRY) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

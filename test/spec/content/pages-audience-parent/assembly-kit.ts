import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { PageAudienceReads } from '../../../../apps/api/src/modules/content/application/page-audience.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';

// Read the production factory without starting Nest or replacing its audience provider.
export async function assembledReads(db: Kysely<DB>): Promise<PageAudienceReads> {
  // URL imports keep decorated controllers out of the spec project's erasable-only compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): { imports?: readonly unknown[] } } };
  const config = loadConfig({ APP_ENV: 'test' });
  const clock = new FixedClock('2032-06-15T12:00:00.000Z');
  const root = AppModule.forEntry({
    entry: 'api',
    config,
    clock,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }, { write() {} }),
  });
  type Module = { module?: { name?: string }; providers?: readonly unknown[] };
  const content = (root.imports ?? []).find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as Module).module?.name === 'ContentPublicModule',
  ) as Module | undefined;
  expect(content, 'api must mount content').toBeDefined();
  type Provider = {
    provide: symbol;
    useFactory(
      config: ReturnType<typeof loadConfig>,
      clock: FixedClock,
      db: Kysely<DB>,
    ): PageAudienceReads | null;
  };
  const provider = content!.providers?.find((item) => {
    if (typeof item !== 'object' || item === null || !('provide' in item)) return false;
    return typeof item.provide === 'symbol' && item.provide.description === 'AUDIENCE_READS';
  }) as Provider | undefined;
  expect(provider, 'content audience read provider must be assembled').toBeDefined();
  expect(provider!.useFactory).toBeTypeOf('function');
  const reads = provider!.useFactory(config, clock, db);
  expect(reads).not.toBeNull();
  return reads!;
}

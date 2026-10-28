// B2-11e: content's console module as ContentAdminModule.forAdmin builds it from its options, the
// config item and switch use cases resolved from forAdmin's own providers (their inject lists
// filled with fixtures) over a Kysely handle on DummyDriver: no database, no port, every
// statement answers no rows. Values come from content's index.ts only (URL import after
// reflect-metadata, as test/spec/content/config-invite-reward/kit.ts).
import { createRequire } from 'node:module';
import type { DB as Database } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type * as Content from '../../../../apps/api/src/modules/content/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FixedClock,
  ROOT_LOGGER,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export const ACTOR = {
  appId: 'b211e_app',
  adminId: '0193a000-0000-7000-8000-000000000001',
  loginName: 'b211e',
  ip: '203.0.113.7',
  traceId: 'b211e-trace',
} as const;

type ExtraOptions = Omit<Content.ContentAdminOptions, 'auditWriter'>;

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

function factoryOf(providers: readonly unknown[], token: unknown): FactoryProvider {
  const provider = providers.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'provide' in entry &&
      entry.provide === token &&
      'useFactory' in entry,
  );
  if (provider === undefined) throw new Error('content admin module: no factory provider');
  return provider as FactoryProvider;
}

/** Calls the provider of `token` with the fixtures its inject list names; absent optional → undefined. */
async function resolve(
  providers: readonly unknown[],
  token: unknown,
  values: ReadonlyMap<unknown, unknown>,
): Promise<unknown> {
  const provider = factoryOf(providers, token);
  const args = (provider.inject ?? []).map((entry) => {
    const wrapped = typeof entry === 'object' && entry !== null && 'token' in entry;
    const key = wrapped ? (entry as { token: unknown }).token : entry;
    if (values.has(key)) return values.get(key);
    if (wrapped && (entry as { optional?: boolean }).optional === true) return undefined;
    throw new Error(`content admin module: no fixture for ${String(key)}`);
  });
  return provider.useFactory(...args);
}

export async function harness(options: ExtraOptions, database: 'present' | 'absent' = 'present') {
  apiRequire('reflect-metadata');
  const content = (await import(
    new URL('apps/api/src/modules/content/index.ts', ROOT).href
  )) as typeof Content;
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const clock = new FixedClock('2026-10-29T02:00:00.000Z');
  const logger = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv: 'test' },
    { write: () => undefined },
  );
  const values = new Map<unknown, unknown>([
    [CLOCK, clock],
    [ROOT_LOGGER, logger],
    [APP_CONFIG, loadConfig({ APP_ENV: 'test' })],
    ...(database === 'present' ? [[DB, db] as const] : []),
  ]);
  const module = content.ContentAdminModule.forAdmin({
    auditWriter: () => ({ append: async () => undefined }),
    ...options,
  });
  const providers = (module.providers ?? []) as readonly unknown[];
  return {
    content,
    db,
    clock,
    configItems: (await resolve(
      providers,
      content.ConfigItemAdmin,
      values,
    )) as Content.ConfigItemAdmin,
    switches: (await resolve(
      providers,
      content.KillSwitchAdmin,
      values,
    )) as Content.KillSwitchAdmin,
    close: () => db.destroy(),
  };
}

/** The settled rejection of `work` (undefined when it resolves). */
export async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

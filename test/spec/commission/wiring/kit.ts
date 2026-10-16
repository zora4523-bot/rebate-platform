// B2-03d: exercise actual AppModule provider factories without booting servers or a DB.
// Only infrastructure readers are replaced; selection, the real quoter and ALS stay real.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, vi } from 'vitest';
import type { CardRebateQuoter } from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import type { CommissionRebateQuoter } from '../../../../apps/api/src/modules/commission/application/types.ts';
import type {
  UserLevelReaderOptions,
  UserLevelReader,
} from '../../../../apps/api/src/modules/identity/ports/user-level.ts';
import type { LinkOpenReadPlan } from '../../../../apps/api/src/modules/linking/application/link-open-reads.ts';
import type {
  UnionEndpoint,
  UnionMode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { fixture, commission, APP } from '../quoter/fixtures.ts';

export { APP, OTHER_APP, NORMAL, item, viewer, version, CONFIG_KEYS } from '../quoter/fixtures.ts';
export {
  withOpenReads,
  OpenReadNotPrepared,
} from '../../../../apps/api/src/modules/linking/application/link-open-reads.ts';

// URL imports keep Nest parameter decorators out of the test project's erasable TS graph.
const root = new URL('../../../../', import.meta.url);
interface ModuleShape {
  imports?: unknown[];
  providers?: unknown[];
}
interface Factory {
  provide: unknown;
  inject?: unknown[];
  useFactory?: (...args: unknown[]) => unknown;
  useValue?: unknown;
  useExisting?: unknown;
}
export const appModule = (await import(new URL('apps/api/src/app.module.ts', root).href)) as {
  AppModule: { forEntry(options: object): ModuleShape };
};
const platform = (await import(new URL('apps/api/src/modules/platform/index.ts', root).href)) as {
  APP_CONFIG: symbol;
  CLOCK: symbol;
  DB: symbol;
  ROOT_LOGGER: symbol;
  FIELD_CRYPTO: symbol;
  loadConfig(env: Record<string, string>): object;
};
const catalog = (await import(new URL('apps/api/src/modules/catalog/index.ts', root).href)) as {
  RebateQuoter: unknown;
  GovernedUnion: unknown;
  createDemoRebateQuoter: typeof import('../../../../apps/api/src/modules/catalog/application/card-assembler.ts').createDemoRebateQuoter;
  processItemRefCipher: () => unknown;
};
const identity = (await import(new URL('apps/api/src/modules/identity/index.ts', root).href)) as {
  createUserLevelReader(options: UserLevelReaderOptions): UserLevelReader;
};
const content = (await import(new URL('apps/api/src/modules/content/index.ts', root).href)) as {
  createContentReader: (...args: unknown[]) => unknown;
};
const union = (await import(new URL('apps/api/src/modules/union/index.ts', root).href)) as {
  UNION_ENDPOINTS: symbol;
};
const linking = (await import(new URL('apps/api/src/modules/linking/index.ts', root).href)) as {
  LINK_OPEN_PORTS: symbol;
};

export type ReadPlan = LinkOpenReadPlan & { readonly callerUserId: string | null };
export interface QuotePorts {
  quoter: CardRebateQuoter;
  quoteReads: { prepare(plan: ReadPlan): Promise<void> };
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

export function plan(overrides: Partial<ReadPlan> = {}): ReadPlan {
  return {
    appId: APP,
    platform: 'taobao',
    callerUserId: 'viewer-l2',
    identities: [{ userId: 'viewer-l1', pidScene: 'share', noRebate: false }],
    ...overrides,
  };
}

export function endpoints(modes: readonly UnionMode[]): UnionEndpoint[] {
  return modes.map((mode, index) => ({
    platform: (['taobao', 'jd', 'pdd'] as const)[index]!,
    mode,
    baseUrl: null,
    quotaKey: `synthetic-${index}`,
  }));
}

export async function outcome<T>(work: () => T | Promise<T>) {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

export function wiringFixture() {
  const f = fixture();
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  databases.push(db);
  const rules = vi
    .spyOn(commission, 'createRuleSetReader')
    .mockReturnValue({ publishedVersions: f.publishedVersions });
  const levels = vi
    .spyOn(identity, 'createUserLevelReader')
    .mockReturnValue({ levelOf: f.levelOf });
  vi.spyOn(content, 'createContentReader').mockReturnValue({ configValue: f.configValue });
  const real = vi.spyOn(commission, 'createCommissionRebateQuoter');
  const demo = vi.spyOn(catalog, 'createDemoRebateQuoter');

  function assembly(
    appEnv: 'local' | 'test' | 'staging' | 'prod',
    configured: readonly UnionEndpoint[],
    hasDb = true,
  ) {
    const config = { ...platform.loadConfig({ APP_ENV: 'test' }), appEnv };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const module = appModule.AppModule.forEntry({ entry: 'api', config, clock: f.clock, logger });
    const factories = new Map<unknown, Factory>();
    function collect(candidate: unknown): void {
      if (candidate === null || typeof candidate !== 'object') return;
      const shape = candidate as ModuleShape;
      for (const child of shape.imports ?? []) collect(child);
      for (const provider of shape.providers ?? []) {
        if (typeof provider === 'object' && provider !== null && 'provide' in provider) {
          const factory = provider as Factory;
          factories.set(factory.provide, factory);
        }
      }
    }
    collect(module);
    // Resolve only the quote dependency graph. No lifecycle, adapters, queues or SQL execute.
    const values = new Map<unknown, unknown>([
      [platform.APP_CONFIG, config],
      [platform.CLOCK, f.clock],
      [platform.ROOT_LOGGER, logger],
      [platform.FIELD_CRYPTO, catalog.processItemRefCipher()],
      [union.UNION_ENDPOINTS, configured],
      [catalog.GovernedUnion, { adapter: vi.fn() }],
      [platform.DB, hasDb ? db : undefined],
    ]);
    async function resolve(token: unknown): Promise<unknown> {
      if (values.has(token)) return values.get(token);
      const provider = factories.get(token);
      expect(provider, `provider ${String(token)} must exist in AppModule`).toBeDefined();
      if (provider === undefined) throw new Error('missing provider');
      let value: unknown;
      if ('useValue' in provider) value = provider.useValue;
      else if ('useExisting' in provider) value = await resolve(provider.useExisting);
      else {
        expect(provider.useFactory).toBeTypeOf('function');
        const args = await Promise.all(
          (provider.inject ?? []).map((entry) => {
            if (typeof entry === 'object' && entry !== null && 'token' in entry) {
              if (
                'optional' in entry &&
                entry.optional &&
                !factories.has(entry.token) &&
                !values.has(entry.token)
              )
                return undefined;
              return resolve(entry.token);
            }
            return resolve(entry);
          }),
        );
        value = await provider.useFactory!(...args);
      }
      values.set(token, value);
      return value;
    }
    return {
      quote: () => resolve(catalog.RebateQuoter) as Promise<CardRebateQuoter>,
      open: () => resolve(linking.LINK_OPEN_PORTS) as Promise<QuotePorts>,
    };
  }

  async function live() {
    const assembled = assembly('test', endpoints(['demo', 'replay', 'live']));
    const result = await outcome(assembled.quote);
    expect(result, 'live must assemble the commission quoter').toHaveProperty('value');
    const quoter = result.value!;
    expect(real).toHaveBeenCalledTimes(1);
    expect(demo).not.toHaveBeenCalled();
    expect(rules).toHaveBeenCalledWith({ db });
    expect(levels).toHaveBeenCalledWith({ db });
    const prepare = vi.spyOn(quoter as CommissionRebateQuoter, 'prepare');
    const options = real.mock.calls[0]![0];
    const ports = await assembled.open();
    expect(ports.quoter).toBe(quoter);
    expect(prepare).not.toHaveBeenCalled();
    return { quoter, ports, prepare, options };
  }
  return { ...f, db, rules, levels, real, demo, assembly, live };
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type Clock,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionModule,
  isPriceAnomaly,
  type CallCtx,
  type TaobaoPriceConfigReader,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionItem,
  type UnionRegistry,
} from '../../../../apps/api/src/modules/union/index.ts';
import { APP, BASIS, KEYS, OTHER_APP, UNKNOWN, expectKeyWarn, fakeConfig, logged } from './kit.ts';

// B1-22q review r1 S1: the running entry reads price.taobao.* through UnionModule.forRoot's
// `config` option (B1-22d's `config` shape), and app.module hands it content's reader.
// Real Nest factories, no listener, no network, no real database. Synthetic data only.

afterEach(() => {
  vi.restoreAllMocks();
});

const clock = new FixedClock('2031-02-03T04:05:06.789Z');
const ctx: CallCtx = {
  appId: APP,
  requestId: 'wiring-price-config-request',
  purpose: 'online',
};
const unknownScenario: CallCtx = { ...ctx, scenario: 'unknown_promo' };
const keyword = '演示';
/** Stands in for the entry's database handle; the fake config factory never queries it. */
const database = Object.freeze({ synthetic: 'price-config-db-handle' });
const demoEndpoints: readonly UnionEndpoint[] = (['taobao', 'jd', 'pdd'] as const).map(
  (platform) => ({ platform, mode: 'demo', baseUrl: null, quotaKey: `demo:${platform}` }),
);

type ConfigFactory = (db: unknown, clock: Clock) => TaobaoPriceConfigReader;
interface ModuleOptions {
  readonly config?: ConfigFactory;
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
  UnionModule: { forRoot(directory?: string, options?: ModuleOptions): ModuleMetadata };
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

/** A config factory that hands out `reader` and records what it was built with. */
function configFactory(reader: TaobaoPriceConfigReader) {
  const builds: (readonly [unknown, Clock])[] = [];
  const factory: ConfigFactory = (db, used) => {
    builds.push([db, used]);
    return reader;
  };
  return { factory, builds };
}

/** UnionModule.forRoot (with `options` when given) under Nest, every platform in demo mode. */
async function assemble(options?: ModuleOptions) {
  const union = (await import(
    new URL('../../../../apps/api/src/modules/union/union.module.ts', import.meta.url).href
  )) as ModuleExports;
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as NestTesting;
  const warn = vi.fn();
  const logger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  const values = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], loadConfig({ APP_ENV: 'test' })],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
    [platform['DB'], database],
  ]);
  class FixtureGlobals {}
  const metadata =
    options === undefined
      ? union.UnionModule.forRoot()
      : union.UnionModule.forRoot(undefined, options);
  const context = await testing.Test.createTestingModule({
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
            ? { provide: provider.provide, useValue: demoEndpoints }
            : provider,
        ),
      },
    ],
  }).compile();
  await context.init();
  return { context, registry: context.get<UnionRegistry>(union.UNION_REGISTRY), warn };
}

/** Every taobao demo entry point that prices items: search, feed, detail and channel ranking. */
async function pricedItems(port: UnionAdapter, call: CallCtx): Promise<UnionItem[]> {
  const search = await port.searchItems({ keyword }, call);
  expect(search.items.length).toBeGreaterThan(0);
  expect(port.materialFeed).toBeTypeOf('function');
  expect(port.channelRanking).toBeTypeOf('function');
  const feed = await port.materialFeed!({}, call);
  expect(feed.items.length).toBeGreaterThan(0);
  const detail = await port.getItem(search.items[0]!, call);
  const ranking = await port.channelRanking!(
    { channelId: 'demo-price-config-channel', categoryId: null, pageNo: 1, pageSize: 10 },
    call,
  );
  expect(ranking.items.length).toBeGreaterThan(0);
  return [...search.items, ...feed.items, detail, ...ranking.items.map((entry) => entry.item)];
}

function expectNormal(item: UnionItem): void {
  expect(isPriceAnomaly(item)).toBe(false);
  expect(Object.hasOwn(item, 'price_anomaly_reason')).toBe(false);
  expect(item.final_price_fen).toBe(item.price_fen - item.coupon_fen);
}

function expectUnknownAnomaly(item: UnionItem): void {
  expect(item).toMatchObject({
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
}

it('[AC-B1-22q-WIRING#1] UnionModule.forRoot 的 config 进入淘宝演示映射：按 ctx.appId 读五个键，改配置下一次即变', async () => {
  // Baseline: without the option the 08 default (unavailable) keeps the unlisted name unpriced.
  const plain = await assemble();
  try {
    for (const item of await pricedItems(plain.registry.get('taobao'), unknownScenario)) {
      expectUnknownAnomaly(item);
    }
  } finally {
    await plain.context.close();
  }
  const config = fakeConfig();
  config.set(UNKNOWN, 'add_back', APP);
  const { factory, builds } = configFactory(config.reader);
  const { context, registry } = await assemble({ config: factory });
  try {
    const port = registry.get('taobao');
    for (const item of await pricedItems(port, unknownScenario)) expectNormal(item);
    expect(builds.length).toBeGreaterThan(0);
    for (const [db, used] of builds) {
      expect(db).toBe(database);
      expect(used).toBe(clock);
    }
    expect(config.calls.length).toBeGreaterThan(0);
    expect(config.calls.every((call) => call.appId === APP)).toBe(true);
    expect(new Set(config.calls.map((call) => call.key))).toEqual(new Set(KEYS));
    // Another app has no configuration: its items keep the 08 default.
    const other = await port.searchItems({ keyword }, { ...unknownScenario, appId: OTHER_APP });
    expect(other.items.length).toBeGreaterThan(0);
    for (const item of other.items) expectUnknownAnomaly(item);
    expect(config.calls.some((call) => call.appId === OTHER_APP)).toBe(true);
    // Changing the stored value takes effect on the next call (no cache in union).
    config.set(UNKNOWN, 'unavailable', APP);
    for (const item of await pricedItems(port, unknownScenario)) expectUnknownAnomaly(item);
    config.set(UNKNOWN, 'count', APP);
    for (const item of await pricedItems(port, unknownScenario)) expectNormal(item);
  } finally {
    await context.close();
  }
});

/** The taobao demo search of a module assembled without the option (08 defaults). */
async function defaultSearch(call: CallCtx): Promise<readonly UnionItem[]> {
  const plain = await assemble();
  try {
    return (await plain.registry.get('taobao').searchItems({ keyword }, call)).items;
  } finally {
    await plain.context.close();
  }
}

it('[AC-B1-22q-WIRING#2] 装配后 basis=coupon_only 生效：券不变，券前价不再扣平台立减', async () => {
  const base = await defaultSearch(ctx);
  const config = fakeConfig();
  config.set(BASIS, 'coupon_only', APP);
  const { context, registry } = await assemble({ config: configFactory(config.reader).factory });
  try {
    const degraded = (await registry.get('taobao').searchItems({ keyword }, ctx)).items;
    const ids = (items: readonly UnionItem[]) => items.map((item) => Reflect.get(item, 'item_id'));
    expect(ids(degraded)).toEqual(ids(base));
    let raised = 0;
    degraded.forEach((item, index) => {
      const before = base[index]!;
      expectNormal(item);
      expect(item.coupon_fen).toBe(before.coupon_fen);
      expect(item.price_fen >= before.price_fen).toBe(true);
      if (item.price_fen > before.price_fen) raised++;
    });
    expect(raised).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

it('[AC-B1-22q-WIRING#3] 装配后取值不合法：回落默认，经根 logger 每次读取告警一条，只带键名不带商品信息', async () => {
  const base = await defaultSearch(ctx);
  const config = fakeConfig();
  config.set(BASIS, 'COUPON_ONLY', APP);
  const { context, registry, warn } = await assemble({
    config: configFactory(config.reader).factory,
  });
  try {
    const page = await registry.get('taobao').searchItems({ keyword }, ctx);
    expect(page.items).toEqual(base);
    const basisReads = config.calls.filter((call) => call.key === BASIS).length;
    expect(basisReads).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(basisReads);
    for (const call of warn.mock.calls) expectKeyWarn(call, BASIS);
    const text = logged(warn.mock.calls);
    for (const item of page.items) {
      expect(text).not.toContain(item.title);
      expect(text).not.toContain(String(Reflect.get(item, 'item_id')));
      const couponIds: unknown = Reflect.get(item, 'coupon_ids');
      if (typeof couponIds === 'string') expect(text).not.toContain(couponIds);
    }
  } finally {
    await context.close();
  }
});

/** Real Kysely compilation over an in-memory driver: records every statement, answers no rows. */
function recordingDatabase() {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(statement);
      return { rows: [] };
    },
    async *streamQuery() {
      expect.fail('the configuration read must not stream rows');
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
  return { db, statements };
}

it.each(['api', 'worker', 'stream'] as const)(
  '[AC-B1-22q-WIRING#4] %s 入口把 content 的配置读取器作为 config 交给 UnionModule.forRoot',
  async (entry) => {
    const forRoot = vi.spyOn(UnionModule, 'forRoot');
    // As in the existing entry assembly tests: keep decorated controllers out of the spec
    // project's TypeScript compilation.
    const { AppModule } = (await import(
      new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
    )) as { AppModule: { forEntry(options: object): unknown } };
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} }),
    });
    expect(forRoot).toHaveBeenCalled();
    const args: readonly unknown[] = forRoot.mock.calls.at(-1) ?? [];
    const options = args[1] as ModuleOptions | undefined;
    expect(options?.config).toBeTypeOf('function');
    const recorded = recordingDatabase();
    try {
      const reader = options!.config!(recorded.db, clock);
      expect(reader.configValue).toBeTypeOf('function');
      await reader.configValue(APP, UNKNOWN);
      // content's reader of config_items, for this app and key.
      expect(
        recorded.statements.some(
          (statement) =>
            statement.sql.includes('config_items') &&
            statement.parameters.includes(APP) &&
            statement.parameters.includes(UNKNOWN),
        ),
      ).toBe(true);
    } finally {
      await recorded.db.destroy();
    }
  },
);

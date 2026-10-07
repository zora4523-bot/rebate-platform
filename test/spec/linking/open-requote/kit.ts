// Synthetic ports only at the unimplemented conversion boundary. Ownership, registration,
// catalog assembly, idempotency and database writes use their real public entry points.
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createLinkOpenRequote,
  createLinkRegistration,
  type Caller,
  type LinkOpenCacheKey,
  type LinkOpenCachedJump,
  type LinkOpenConversionInput,
  type LinkOpenJump,
  type LinkOpenOwnerResult,
  type LinkOpenPrice,
  type LinkOpenRequoteInput,
  type LinkOpenRequoteOptions,
  type LinkOpenRequoteOutcome,
  type RegistrationContext,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { createIdempotency, FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ActivePidInput, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { caller, input, pid, seed, START, USER_A } from '../register/kit.ts';

export { stored, unknownPricePddLink } from '../open-owner/kit.ts';
export { DEVICE_A, DEVICE_B, QUOTED, START, USER_A, USER_B } from '../register/kit.ts';

/** Test database handle; the factory comes from @couli/db/testing, which only *.int.test.ts may import. */
interface TestDatabaseHandle {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** Called at module scope; only the container integration runner executes these hooks. */
export function databaseFixture(createTestDatabase: () => Promise<TestDatabaseHandle>) {
  let database: TestDatabaseHandle;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
    await seed(db);
  });
  afterAll(async () => {
    await destroyDb(db);
    await database.drop();
  });
  return () => db;
}

export function jump(label = 'synthetic-rebate'): LinkOpenJump {
  return {
    primary: { type: 'h5', value: `https://example.invalid/${label}` },
    fallbacks: [],
    expire_at: '2031-06-06T07:08:09.000Z',
  };
}

/** No TTL or identity policy here: the system under test must apply both. */
export function memoryCache() {
  const entries = new Map<string, LinkOpenCachedJump>();
  function keyOf(key: LinkOpenCacheKey) {
    return JSON.stringify([
      key.appId,
      key.userId,
      key.platform,
      key.productKey,
      key.rawItemId,
      key.pid,
      key.pidScene,
      key.noRebate,
    ]);
  }
  const get = vi.fn(async (key: LinkOpenCacheKey) => entries.get(keyOf(key)) ?? null);
  const put = vi.fn(async (key: LinkOpenCacheKey, value: LinkOpenCachedJump) => {
    entries.set(keyOf(key), value);
  });
  return { get, put, entries };
}

export function fixture(db: Kysely<DB>, opener: Partial<Caller> = {}) {
  const clock = new FixedClock(START);
  const current = vi.fn(async () => caller(opener));
  const config = new Map<string, number | boolean>();
  const configValue = vi.fn(async (_appId: string, key: string) => {
    const value = config.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  const attrCode = vi.fn(async (_appId: string, userId: string) =>
    userId === USER_A ? 'demo0001' : 'demo0002',
  );
  const getActivePid = vi.fn(async (query: ActivePidInput) => pid(query));
  const base = {
    db,
    clock,
    callerContext: { current },
    config: { configValue },
    attrCodes: { attrCode },
    pids: { getActivePid },
  };
  const registration = createLinkRegistration({ ...base, context: { scene: 'search' } });
  const register = vi.fn((value: RegisterLinkInput) => registration.register(value));
  const quote = vi.fn(
    async (
      _item: UnionItem,
      _viewer: Viewer,
      context?: CardQuoteContext,
    ): Promise<RebateQuote> => ({
      rebateMinFen: 229n,
      rebateMaxFen: 229n,
      rebateBasis: context?.rebateBasis ?? 'normal',
      estNetPriceFen: null,
    }),
  );
  const entry = createCatalogCardEntry({
    clock,
    viewerContext: { current },
    quoter: { quote },
    registrar: { register },
    sourceLinks: registration,
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const assemble = vi.fn((value: CatalogCardInput) => entry.assemble(value));
  const state: { price: LinkOpenPrice } = {
    price: { kind: 'available', input: { ...input(), stale: false } },
  };
  const fetch = vi.fn(async (owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> => {
    void owner;
    return state.price;
  });
  const convert = vi.fn(async (value: LinkOpenConversionInput) =>
    jump(value.noRebate ? 'synthetic-without-attribution' : 'synthetic-rebate'),
  );
  const cache = memoryCache();
  const idempotency = createIdempotency({ db, clock, logger: { warn: vi.fn() } });
  const execute = vi.fn(idempotency.execute.bind(idempotency));
  const options: LinkOpenRequoteOptions = {
    ...base,
    catalog: { assemble },
    prices: { fetch },
    conversion: { convert },
    cache,
    idempotency: { execute },
  };
  let serial = 0;
  const request = (
    linkId: string,
    extra: Partial<LinkOpenRequoteInput> = {},
  ): LinkOpenRequoteInput => ({
    linkId,
    idempotencyKey: `synthetic-open-${++serial}`,
    traceId: 'synthetic-trace',
    client: 'ios',
    ...extra,
  });
  return {
    options,
    clock,
    current,
    config,
    configValue,
    quote,
    register,
    assemble,
    state,
    fetch,
    convert,
    cache,
    execute,
    request,
  };
}

export async function source(
  f: ReturnType<typeof fixture>,
  price = 2990n,
  item: Partial<UnionItem> = {},
  context: RegistrationContext = { scene: 'search' },
  owner: Partial<Caller> = {},
) {
  const original = input();
  const value = {
    ...original,
    item: {
      ...original.item,
      price_fen: price,
      coupon_fen: 0n,
      final_price_fen: price,
      coupon_ids: '',
      ...item,
    },
    ref: { ...original.ref, platform: item.platform ?? 'taobao' },
  };
  const registration = createLinkRegistration({
    ...f.options,
    context,
    callerContext: { current: async () => caller(owner) },
  });
  const { linkId } = await registration.register(value);
  f.state.price = {
    kind: 'available',
    input: {
      item: { ...value.item, quoted_at: f.clock.now().toISOString() },
      ref: value.ref,
      entrySource: value.entrySource,
      stale: false,
    },
  };
  return f.options.db
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', linkId)
    .executeTakeFirstOrThrow();
}

export function reprice(
  f: ReturnType<typeof fixture>,
  price: bigint,
  patch: Partial<UnionItem> = {},
) {
  if (f.state.price.kind !== 'available') throw new Error('synthetic priced fixture required');
  f.state.price = {
    kind: 'available',
    input: {
      ...f.state.price.input,
      item: {
        ...f.state.price.input.item,
        price_fen: price,
        coupon_fen: 0n,
        final_price_fen: price,
        coupon_ids: '',
        quoted_at: f.clock.now().toISOString(),
        ...patch,
      },
    },
  };
}

export function service(f: ReturnType<typeof fixture>) {
  // Outside every error assertion: negative tests must also be red on the skeleton.
  return createLinkOpenRequote(f.options);
}

export function success(value: LinkOpenRequoteOutcome) {
  expect(value.code).toBe(0);
  expect(value.data).not.toBeNull();
  return value.data!;
}

export function openLogs(db: Kysely<DB>, linkId: string) {
  return db
    .selectFrom('link_logs')
    .selectAll()
    .where('event', '=', 'open')
    .where('link_id', '=', linkId)
    .orderBy('id')
    .execute();
}

export function attempts(db: Kysely<DB>, linkId: string) {
  return db
    .selectFrom('link_open_attempts')
    .selectAll()
    .where('link_id', '=', linkId)
    .orderBy('attempt_id')
    .execute();
}

export function cacheKey(
  row: Awaited<ReturnType<typeof source>>,
  userId = USER_A,
): LinkOpenCacheKey {
  return {
    appId: row.app_id,
    userId,
    platform: row.platform,
    productKey: row.product_key,
    rawItemId: row.raw_item_id,
    pid: row.pid,
    pidScene: row.pid_scene!,
    noRebate: false,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

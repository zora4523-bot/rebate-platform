// B1-06m owns this fixture. Only frozen fixture data and public module entry points are reused.
// No database factory import here: the integration file supplies it.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createLinkOpenRequote,
  createLinkRegistration,
  type Caller,
  type LinkOpenCacheKey,
  type LinkOpenCachedJump,
  type LinkOpenConversionInput,
  type LinkOpenJump,
  type LinkOpenPrice,
  type LinkOpenRequoteInput,
  type LinkOpenRequoteOptions,
  type LinkOpenRequoteOutcome,
} from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createIdempotency,
  FixedClock,
  type HandlerResult,
  type IdempotentRequest,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { ActivePidInput } from '../../../../apps/api/src/modules/union/index.ts';
import { caller, input, pid, seed, START, USER_A } from '../register/kit.ts';

export { USER_A, USER_B } from '../register/kit.ts';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function databaseFixture(createTestDatabase: () => Promise<TestDatabase>) {
  let database: TestDatabase;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
    await seed(db);
  });
  afterAll(async () => {
    await destroyDb(db);
    await database.drop();
  });
  return () => db;
}

export function jump(): LinkOpenJump {
  return {
    primary: { type: 'h5', value: 'https://example.test/synthetic-rebate' },
    fallbacks: [],
    expire_at: '2031-05-06T07:23:09.000Z',
  };
}

interface TransactionHooks {
  before?: (request: IdempotentRequest, trx: Transaction<DB>) => Promise<void>;
  after?: (
    request: IdempotentRequest,
    trx: Transaction<DB>,
    result: HandlerResult,
  ) => Promise<void>;
}

export function fixture(db: Kysely<DB>, opener: Partial<Caller> = {}) {
  const clock = new FixedClock(START);
  const current = vi.fn(async () => caller(opener));
  const base = {
    db,
    clock,
    callerContext: { current },
    config: { configValue: vi.fn(async () => null) },
    attrCodes: {
      attrCode: vi.fn(async (_appId: string, userId: string) =>
        userId === USER_A ? 'demo0001' : 'demo0002',
      ),
    },
    pids: { getActivePid: vi.fn(async (query: ActivePidInput) => pid(query)) },
  };
  const registration = createLinkRegistration({ ...base, context: { scene: 'search' } });
  const catalog = createCatalogCardEntry({
    clock,
    viewerContext: { current },
    quoter: {
      quote: async () => ({
        rebateMinFen: 229n,
        rebateMaxFen: 229n,
        rebateBasis: 'normal',
        estNetPriceFen: null,
      }),
    },
    registrar: registration,
    sourceLinks: registration,
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const assemble = vi.fn((value: CatalogCardInput) => catalog.assemble(value));
  const state: { price: LinkOpenPrice } = {
    price: { kind: 'available', input: { ...input(), stale: false } },
  };
  const fetch = vi.fn(async (): Promise<LinkOpenPrice> => state.price);
  const convert = vi.fn(async (value: LinkOpenConversionInput) => {
    void value;
    return jump();
  });
  const entries = new Map<string, LinkOpenCachedJump>();
  const keyOf = (key: LinkOpenCacheKey) =>
    JSON.stringify([
      key.appId,
      key.userId,
      key.platform,
      key.productKey,
      key.rawItemId,
      key.pid,
      key.pidScene,
      key.noRebate,
    ]);
  const cache = {
    get: vi.fn(async (key: LinkOpenCacheKey) => entries.get(keyOf(key)) ?? null),
    put: vi.fn(async (key: LinkOpenCacheKey, value: LinkOpenCachedJump) => {
      entries.set(keyOf(key), value);
    }),
  };
  const hooks: TransactionHooks = {};
  const real = createIdempotency({ db, clock, logger: { warn: vi.fn() } });
  // Keep execute real: the old two-commit implementation must resolve and fail an assertion,
  // rather than accidentally encountering a fake port or an unavailable method.
  const execute = vi.fn(real.execute);
  const executeInTransaction = vi.fn<typeof real.executeInTransaction>((request, handler) =>
    real.executeInTransaction(request, async (trx) => {
      await hooks.before?.(request, trx);
      const result = await handler(trx);
      // Deliberately between business writes and the idempotency completion record.
      await hooks.after?.(request, trx, result);
      return result;
    }),
  );
  const idempotency = { ...real, execute, executeInTransaction };
  const options: LinkOpenRequoteOptions = {
    ...base,
    catalog: { assemble },
    prices: { fetch },
    conversion: { convert },
    cache,
    idempotency,
  };
  let serial = 0;
  const request = (linkId: string): LinkOpenRequoteInput => ({
    linkId,
    idempotencyKey: `synthetic-open-${++serial}`,
    traceId: 'synthetic-trace',
    client: 'ios',
  });
  return {
    options,
    clock,
    current,
    state,
    fetch,
    assemble,
    convert,
    cache,
    hooks,
    execute,
    executeInTransaction,
    request,
  };
}

export async function source(f: ReturnType<typeof fixture>, userId: string | null = USER_A) {
  const original = input();
  const value = {
    ...original,
    item: {
      ...original.item,
      price_fen: 2990n,
      coupon_fen: 0n,
      final_price_fen: 2990n,
      coupon_ids: '',
    },
  };
  const registration = createLinkRegistration({
    ...f.options,
    context: { scene: 'search' },
    callerContext: { current: async () => caller({ userId }) },
  });
  const { linkId } = await registration.register(value);
  f.state.price = { kind: 'available', input: { ...value, stale: false } };
  return f.options.db
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', linkId)
    .executeTakeFirstOrThrow();
}

export function reprice(f: ReturnType<typeof fixture>, price: bigint) {
  if (f.state.price.kind !== 'available') throw new Error('synthetic price fixture required');
  f.state.price = {
    kind: 'available',
    input: {
      ...f.state.price.input,
      item: { ...f.state.price.input.item, price_fen: price, final_price_fen: price },
    },
  };
}

export function service(f: ReturnType<typeof fixture>) {
  return createLinkOpenRequote(f.options);
}

export function capture<T>(pending: Promise<T>) {
  return pending.then(
    (returned) => ({ kind: 'returned' as const, returned }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
}

export function success(value: Awaited<ReturnType<typeof capture<LinkOpenRequoteOutcome>>>) {
  expect(value).toMatchObject({ kind: 'returned', returned: { code: 0 } });
  if (value.kind !== 'returned') throw new Error('unreachable after assertion');
  expect(value.returned.data).not.toBeNull();
  return value.returned.data!;
}

// Each file uses one isolated database and sequential tests. Full snapshots also detect
// orphan writes under an unexpected link_id, and changes to a claimed guest's original row.
export async function snapshot(db: Kysely<DB>) {
  const xid = sql<string>`xmin::text`.as('write_xid');
  const links = await db.selectFrom('links').selectAll().select(xid).orderBy('link_id').execute();
  const logs = await db.selectFrom('link_logs').selectAll().select(xid).orderBy('id').execute();
  const attempts = await db
    .selectFrom('link_open_attempts')
    .selectAll()
    .select(xid)
    .orderBy('attempt_id')
    .execute();
  const keys = await db
    .selectFrom('idempotency_keys')
    .selectAll()
    .select(xid)
    .orderBy('id')
    .execute();
  return { links, logs, attempts, keys };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

export function added(before: Snapshot, after: Snapshot) {
  return {
    links: after.links.filter((row) => !before.links.some((old) => old.link_id === row.link_id)),
    logs: after.logs.filter((row) => !before.logs.some((old) => old.id === row.id)),
    attempts: after.attempts.filter(
      (row) => !before.attempts.some((old) => old.attempt_id === row.attempt_id),
    ),
    keys: after.keys.filter((row) => !before.keys.some((old) => old.id === row.id)),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function cacheKey(row: Awaited<ReturnType<typeof source>>): LinkOpenCacheKey {
  return {
    appId: row.app_id,
    userId: row.user_id,
    platform: row.platform,
    productKey: row.product_key,
    rawItemId: row.raw_item_id,
    pid: row.pid,
    pidScene: row.pid_scene!,
    noRebate: false,
  };
}

// B1-08n: union's order-sync ports over a compile-only database (no connection): which queries
// run, and the decisions that need no rows. Row semantics are covered by the database rule tests.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../platform/index.ts';
import type { UnionAdapter, UnionEndpoint } from '../domain/types.ts';
import {
  createGovernedSyncAdapter,
  createUnionOrderReaders,
  createUnionSyncAccess,
} from './order-sync-ports.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function compileOnly(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => void queries.push(event.query.sql),
  });
  handles.push(db);
  return db;
}

/** Waits never end on their own (no timeout fires); an abort rejects them. */
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
};

const endpoint = (mode: UnionEndpoint['mode']): UnionEndpoint => ({
  platform: 'pdd',
  mode,
  baseUrl: mode === 'demo' ? null : 'https://example.invalid',
  quotaKey: 'unit-pdd',
});

it.each(['demo', 'replay'] as const)(
  '[AC-B1-08n#u2] %s 端点的 queryableAccount 为 null，不查库、不记错',
  async (mode) => {
    const queries: string[] = [];
    const logger = { error: vi.fn() };
    const access = createUnionSyncAccess({
      db: compileOnly(queries),
      endpoints: [endpoint(mode)],
      breaker: () => 'closed',
      logger,
    });
    expect(await access.queryableAccount('pdd')).toBeNull();
    expect(await access.queryableAccount('jd')).toBeNull();
    expect(queries).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-08n#u3] live 无账号：每次重查，同一平台只记一次平铺字段的 error', async () => {
  const queries: string[] = [];
  const logger = { error: vi.fn() };
  const access = createUnionSyncAccess({
    db: compileOnly(queries),
    endpoints: [endpoint('live')],
    breaker: () => 'closed',
    logger,
  });
  expect(await access.queryableAccount('pdd')).toBeNull();
  expect(await access.queryableAccount('pdd')).toBeNull();
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('"app"."union_accounts"');
  expect(logger.error.mock.calls).toEqual([
    [{ platform: 'pdd', reason: 'no_union_account' }, 'order_sync_queryable_account_unresolved'],
  ]);
});

it('[AC-B1-08n#u4] offlineCircuitOpen 每次读熔断器、不查库；账号与授权读 app schema', async () => {
  const queries: string[] = [];
  let state: 'closed' | 'open' = 'closed';
  const breaker = vi.fn(() => state);
  const access = createUnionSyncAccess({
    db: compileOnly(queries),
    endpoints: [endpoint('demo')],
    breaker,
    logger: { error: vi.fn() },
  });
  expect(await access.offlineCircuitOpen('pdd')).toBe(false);
  state = 'open';
  expect(await access.offlineCircuitOpen('pdd')).toBe(true);
  expect(breaker.mock.calls).toEqual([['pdd'], ['pdd']]);
  expect(queries).toEqual([]);
  expect(await access.listEnabledAccounts()).toEqual([]);
  expect(
    await access.siteAuthAvailable({ app_id: 'a', platform: 'pdd', union_account_id: 'x' }),
  ).toBe(false);
  expect(queries).toHaveLength(2);
  expect(queries.every((q) => q.includes('"app"."union_accounts"'))).toBe(true);
});

it('[AC-B1-08n#u5] 推广位与同步起点读取：只读、无行时为空', async () => {
  const queries: string[] = [];
  const readers = createUnionOrderReaders(compileOnly(queries));
  expect(
    await readers.pids.find({ appId: 'a', platform: 'pdd', unionAccountId: 'x', pid: 'p' }),
  ).toEqual([]);
  expect(await readers.accounts.syncStartAt({ appId: 'a', unionAccountId: 'x' })).toBeNull();
  expect(queries).toHaveLength(2);
  expect(queries.every((q) => /^select /.test(q))).toBe(true);
  expect(queries[0]).toContain('"app"."union_pids"');
});

it('[AC-B1-08n#u6] createGovernedSyncAdapter 保留治理包装、只暴露离线熔断状态', async () => {
  const raw: UnionAdapter = {
    platform: 'pdd',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const ep = endpoint('demo');
  const governed = createGovernedSyncAdapter(raw, {
    endpoint: ep,
    scheduler,
    quota: { bucketKey: ep.quotaKey, tryAcquire: () => true },
  });
  expect(governed.offlineBreakerState()).toBe('closed');
  expect(governed.adapter).not.toBe(raw);
  await governed.adapter.listOrders(
    { from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:30:00Z' },
    {},
    { appId: 'a', requestId: 'r', purpose: 'order_sync' },
  );
  expect(raw.listOrders).toHaveBeenCalledTimes(1);
  expect(() =>
    createGovernedSyncAdapter(
      { ...raw, platform: 'jd' },
      {
        endpoint: ep,
        scheduler,
        quota: { bucketKey: ep.quotaKey, tryAcquire: () => true },
      },
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_endpoint' }));
});

// B1-08n: the worker's order-sync assembly over a compile-only database (no connection, no
// listen): what building runs, what the handler and scheduler share, and the status-map cache.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type QueueRuntime,
} from '../platform/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
  UnionRegistry,
} from '../union/index.ts';
import { createOrderSyncRuntime, orderSyncToken } from './worker-runtime.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

function rawAdapter(platform: RegisteredPlatform): UnionAdapter {
  return {
    platform,
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
}

function setup() {
  const queries: string[] = [];
  const lines: { msg: string }[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as { msg: string }) },
  );
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const send = vi.fn(async () => 'unit');
  const queue = {
    register,
    send,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as QueueRuntime;
  const endpoints: UnionEndpoint[] = (['pdd', 'jd'] as const).map((platform) => ({
    platform,
    mode: 'demo',
    baseUrl: null,
    quotaKey: `unit-${platform}`,
  }));
  const raws = new Map<RegisteredPlatform, UnionAdapter>();
  const registry: UnionRegistry = {
    registrations: () => [],
    get: (platform) => {
      const adapter = raws.get(platform) ?? rawAdapter(platform);
      raws.set(platform, adapter);
      return adapter;
    },
  };
  const users = { findByAttrCode: vi.fn() };
  const bindings = { findByRelation: vi.fn() };
  const ports = {
    users: vi.fn(() => users),
    bindings: vi.fn(() => bindings),
    quota: vi.fn((endpoint: UnionEndpoint) => ({
      bucketKey: endpoint.quotaKey,
      tryAcquire: () => true,
    })),
  };
  const db = compileOnly(queries);
  const runtime = createOrderSyncRuntime({
    db,
    clock: new FixedClock('2026-10-17T17:30:00.000Z'),
    logger,
    queue,
    events: { publish: vi.fn() },
    endpoints,
    registry,
    ports,
  });
  return { runtime, queries, lines, register, send, raws, ports, users, bindings, db };
}

it('[AC-B1-08n#u7] 装配只注册一次 order-sync，不查库、不投递；端口工厂各调一次', () => {
  const s = setup();
  expect(s.register.mock.calls.map(([name]) => name)).toEqual(['order-sync']);
  expect(s.queries).toEqual([]);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.ports.users.mock.calls).toEqual([[s.db]]);
  expect(s.ports.bindings.mock.calls).toEqual([[s.db]]);
  expect(s.ports.quota.mock.calls.map(([endpoint]) => endpoint.platform)).toEqual(['jd', 'pdd']);
  expect(orderSyncToken()).toBe(orderSyncToken());
  expect(typeof orderSyncToken()).toBe('symbol');
});

it('[AC-B1-08n#u8] 映射表启动时读好并缓存；未调度平台报 MISSING_STATUS_MAP', () => {
  const { runtime } = setup();
  const pdd = runtime.statusMaps('pdd');
  expect(pdd.entries.size).toBeGreaterThan(0);
  expect(runtime.statusMaps('pdd')).toBe(pdd);
  expect(() => runtime.statusMaps('taobao')).toThrow(
    expect.objectContaining({ code: 'MISSING_STATUS_MAP' }),
  );
});

it('[AC-B1-08n#u9] registry 回治理包装后的适配器；没有端点的平台拒绝', () => {
  const s = setup();
  const governed = s.runtime.registry.get('pdd');
  expect(governed).not.toBe(s.raws.get('pdd'));
  expect(s.runtime.registry.get('pdd')).toBe(governed);
  expect(() => s.runtime.registry.get('taobao')).toThrow(/no endpoint for taobao/);
});

it('[AC-B1-08n#u10] 注册的处理器与运行体共用 access：演示端点不拉取、不推进', async () => {
  const s = setup();
  const handler = s.register.mock.calls[0]![1];
  await handler({
    id: 'j1',
    queue: 'order-sync',
    name: 'window',
    attempt: 1,
    payload: {
      app_id: 'unit',
      platform: 'pdd',
      union_account_id: '10000000-0000-4000-8000-00000000000a',
      query_kind: 'increment',
      scene: '-',
      window_start: '2026-10-17T00:00:00.000Z',
      window_end: '2026-10-17T00:30:00.000Z',
    },
  });
  expect(s.raws.get('pdd')!.listOrders).not.toHaveBeenCalled();
  expect(s.queries).toEqual([]);
  expect(s.lines.map((l) => l.msg)).toContain('order_sync_window_account_mismatch');
});

it('[AC-B1-08n#u11] start 只起定时器、不投递；stop 后无残留定时器', async () => {
  vi.useFakeTimers();
  const s = setup();
  expect(vi.getTimerCount()).toBe(0);
  const handle = s.runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.queries).toEqual([]);
  await handle.stop();
  expect(vi.getTimerCount()).toBe(0);
});

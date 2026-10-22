// B1-08w: OrdersModule.forWorker's order-sync provider over fakes (the runtime itself stubbed): the
// snapshot port factory is called once with the worker's handles only when the runtime is built,
// and its port reaches the runtime as its own dependency, not among the read ports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type EventBus,
  type QueueRuntime,
} from '../platform/index.ts';
import type { UnionEndpoint, UnionRegistry } from '../union/index.ts';
import type { CommissionSnapshotPort } from './application/commission-snapshot-step.ts';
import { OrdersModule, type OrdersWorkerOptions } from './orders.module.ts';
import * as workerRuntime from './worker-runtime.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

type Factory = (...args: unknown[]) => unknown;

function setup() {
  const lines: { msg: string }[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as { msg: string }) },
  );
  const clock = new FixedClock('2026-10-22T03:00:00.000Z');
  const port: CommissionSnapshotPort = { create: vi.fn() };
  const snapshots = vi.fn(() => port);
  const options: OrdersWorkerOptions = {
    union: { module: class UnionStub {} },
    users: vi.fn(),
    bindings: vi.fn(),
    quota: vi.fn(),
    sources: vi.fn(),
    snapshots,
  };
  const module = OrdersModule.forWorker(options);
  const provider = module.providers![0] as { useFactory: Factory };
  const stub = { start: vi.fn() } as unknown as workerRuntime.OrderSyncRuntime;
  const makeRuntime = vi.spyOn(workerRuntime, 'createOrderSyncRuntime').mockReturnValue(stub);
  const db = {} as Kysely<DB>;
  const queue = {} as QueueRuntime;
  const events: EventBus = { publish: vi.fn() };
  const endpoints: UnionEndpoint[] = [];
  const registry = { registrations: () => [], get: vi.fn() } as unknown as UnionRegistry;
  const build = (handles: { db?: unknown; queue?: unknown; events?: unknown }) =>
    provider.useFactory(
      clock,
      logger,
      endpoints,
      registry,
      handles.db,
      handles.queue,
      handles.events,
    );
  return {
    lines,
    logger,
    clock,
    port,
    snapshots,
    options,
    stub,
    makeRuntime,
    db,
    queue,
    events,
    endpoints,
    registry,
    build,
  };
}

it('[AC-B1-08w#u1] 有库、队列、事件总线：快照端口工厂只调一次（db、clock、logger），端口作运行体自身依赖、不进 ports', () => {
  const s = setup();
  const result = s.build({ db: s.db, queue: s.queue, events: s.events });
  expect(result).toBe(s.stub);
  expect(s.snapshots.mock.calls).toEqual([[s.db, s.clock, s.logger]]);
  expect(s.makeRuntime).toHaveBeenCalledTimes(1);
  const deps = s.makeRuntime.mock.calls[0]![0];
  expect(deps.snapshots).toBe(s.port);
  expect(deps.db).toBe(s.db);
  expect(deps.clock).toBe(s.clock);
  expect(deps.logger).toBe(s.logger);
  expect(deps.queue).toBe(s.queue);
  expect(deps.events).toBe(s.events);
  expect(deps.endpoints).toBe(s.endpoints);
  expect(deps.registry).toBe(s.registry);
  expect(deps.ports).not.toHaveProperty('snapshots');
  expect(deps.ports).not.toHaveProperty('union');
  expect(deps.ports.users).toBe(s.options.users);
  expect(deps.ports.bindings).toBe(s.options.bindings);
  expect(deps.ports.quota).toBe(s.options.quota);
  expect(deps.ports.sources).toBe(s.options.sources);
  // 构造端口不调用它（装配零查询）。
  expect(s.port.create).not.toHaveBeenCalled();
  expect(s.lines.map((l) => l.msg)).not.toContain('order_sync_disabled');
});

it.each([
  ['db', { queue: true, events: true }],
  ['queue', { db: true, events: true }],
  ['events', { db: true, queue: true }],
] as const)(
  '[AC-B1-08w#u2] 缺 %s：提供 null、只记一条 order_sync_disabled，不构造快照端口与运行体',
  (_missing, present) => {
    const s = setup();
    const result = s.build({
      ...('db' in present ? { db: s.db } : {}),
      ...('queue' in present ? { queue: s.queue } : {}),
      ...('events' in present ? { events: s.events } : {}),
    });
    expect(result).toBeNull();
    expect(s.snapshots).not.toHaveBeenCalled();
    expect(s.makeRuntime).not.toHaveBeenCalled();
    expect(s.lines.filter((l) => l.msg === 'order_sync_disabled')).toHaveLength(1);
  },
);

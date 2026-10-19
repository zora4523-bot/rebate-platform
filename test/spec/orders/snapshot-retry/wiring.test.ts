import { afterEach, expect, it, vi } from 'vitest';
import { compileOnlyDb } from '../wiring/context-kit.ts';
import { capture } from '../attribution/kit.ts';
import { fakePort } from '../commission-snapshot/db-kit.ts';
import {
  createOrderSyncRuntime,
  type OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-08t#24] worker 只有注入 snapshots 才把补偿任务路由到待处理扫描', async () => {
  // DummyDriver 只编译查询，不连接数据库，也不监听端口；验证真正的 worker 装配入口。
  vi.useFakeTimers();
  const queries: string[] = [];
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const deps: OrderSyncRuntimeDeps = {
    db: compileOnlyDb(queries),
    clock: new FixedClock('2026-10-17T17:30:00.000Z'),
    logger: createRootLogger({ level: 'error', entry: 'worker', appEnv: 'test' }, { write() {} }),
    queue: {
      register,
      send: vi.fn(async () => 'synthetic'),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [],
    registry: { registrations: () => [], get: vi.fn() },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
    },
  };
  // 未注入只核对冻结的现有行为，不向它投递补偿任务。
  const legacy = createOrderSyncRuntime(deps).start();
  try {
    expect(queries).toEqual([]);
    expect(vi.getTimerCount()).toBe(scheduledPlatforms().length);
  } finally {
    await legacy.stop();
  }
  register.mockClear();
  // 结构扩展让测试阶段不必改动既有 runtime 实现；实现阶段接入此可选依赖。
  const withSnapshots = { ...deps, snapshots: fakePort() };
  const built = await capture(() => createOrderSyncRuntime(withSnapshots));
  expect(built).toMatchObject({ ok: true });
  if (!built.ok) throw built.error;
  const registrations = register.mock.calls.filter(([queue]) => queue === 'order-sync');
  expect(registrations).toHaveLength(1);
  const handler = registrations[0]![1];
  const running = built.value.start();
  try {
    queries.length = 0;
    const result = await capture(() =>
      handler({
        id: 'synthetic-snapshot-retry',
        queue: 'order-sync',
        name: 'snapshot-retry',
        payload: { app_id: 'app-a' },
        attempt: 1,
      }),
    );
    // 不能按 window 任务解析后丢弃，也不能只增加一个未接入 worker 的独立函数。
    expect(result).toMatchObject({ ok: true });
    expect(queries.some((query) => query.includes('order_sync_pending'))).toBe(true);
  } finally {
    await running.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

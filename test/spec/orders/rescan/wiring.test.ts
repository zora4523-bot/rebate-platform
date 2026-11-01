// B1-04zm: the worker's assembly over a compile-only database (no connection, no listen). The
// worker's account lookup answers null without live endpoints, so a routed window ends without
// fetching: what shows the route is which parser refused which payload.
import { afterEach, expect, it, vi } from 'vitest';
import { compileOnlyDb } from '../wiring/context-kit.ts';
import { capture } from '../attribution/kit.ts';
import { fakePort } from '../commission-snapshot/db-kit.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type JobPayload,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import {
  createOrderSyncRuntime,
  type OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { REGISTERED_PLATFORMS } from '../../../../apps/api/src/modules/union/index.ts';
import { JD_ENABLED, NOW, daysAgo, pddStream, rescanWindow } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const RESCAN = rescanWindow(daysAgo(5), 1_800_000, pddStream);

function named(name: string, payload: JobPayload): ReceivedJob {
  return { id: 'synthetic-wiring-job', queue: 'order-sync', name, payload, attempt: 1 };
}

function harness() {
  const register = vi.fn<(queue: string, handler: JobHandler) => void>();
  const deps: OrderSyncRuntimeDeps = {
    db: compileOnlyDb([]),
    clock: new FixedClock(NOW),
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
  return { deps, register };
}

it.each([
  { label: '未注入 snapshots', withSnapshots: false },
  { label: '注入 snapshots', withSnapshots: true },
])(
  '[AC-B1-04zm#54] $label：rescan-window 路由到回扫处理器，增量和手动任务走原路',
  async ({ withSnapshots }) => {
    const { deps, register } = harness();
    const built = await capture(() =>
      createOrderSyncRuntime(withSnapshots ? { ...deps, snapshots: fakePort() } : deps),
    );
    expect(built).toMatchObject({ ok: true });
    const registrations = register.mock.calls.filter(([queue]) => queue === 'order-sync');
    expect(registrations).toHaveLength(1);
    const handler = registrations[0]![1];

    const increment = { ...RESCAN, query_kind: 'increment' };
    expect(await capture(() => handler(named('rescan-window', RESCAN)))).toMatchObject({
      ok: true,
    });
    const wrongKind = await capture(() => handler(named('rescan-window', increment)));
    expect(wrongKind.ok ? null : wrongKind.error).toBeInstanceOf(OrderSyncPayloadError);

    expect(await capture(() => handler(named('window', increment)))).toMatchObject({ ok: true });
    const rescanAsWindow = await capture(() => handler(named('window', RESCAN)));
    expect(rescanAsWindow.ok ? null : rescanAsWindow.error).toBeInstanceOf(OrderSyncPayloadError);

    // Only the manual parser asks for sync_seq.
    const manual = await capture(() =>
      handler(named('manual_window', { ...increment, sync_id: 'synthetic-sync' })),
    );
    expect(manual.ok ? null : (manual.error as Error).message).toBe('invalid sync_seq');
  },
);

it('[AC-B1-04zm#55] 注入 rescanConfig 才多出回扫定时器，到点读回扫键，停止后不留定时器', async () => {
  vi.useFakeTimers();
  const { deps } = harness();
  const get = vi.fn<(key: string) => Promise<unknown>>(async () => undefined);
  const runtime = createOrderSyncRuntime({
    ...deps,
    ports: { ...deps.ports, rescanConfig: () => ({ get }) },
  });
  const running = runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(scheduledPlatforms().length);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(get).toHaveBeenCalledWith('order_sync.rescan.pdd.enabled');
  } finally {
    await running.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-04zm#70] worker 只回扫 scheduledPlatforms()：jd 开关开，未进调度的平台的回扫键一个都不读', async () => {
  vi.useFakeTimers();
  const { deps } = harness();
  const get = vi.fn<(key: string) => Promise<unknown>>(async (key) =>
    key === JD_ENABLED ? true : undefined,
  );
  const runtime = createOrderSyncRuntime({
    ...deps,
    ports: { ...deps.ports, rescanConfig: () => ({ get }) },
  });
  const running = runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(3_600_000);
  } finally {
    await running.stop();
  }
  const asked = get.mock.calls.map(([key]) => key);
  const unscheduled = REGISTERED_PLATFORMS.filter(
    (platform) => !scheduledPlatforms().includes(platform),
  );
  expect(asked).toContain('order_sync.rescan.pdd.enabled');
  expect(
    asked.filter((key) =>
      unscheduled.some((platform) => key.startsWith(`order_sync.rescan.${platform}.`)),
    ),
  ).toEqual([]);
});

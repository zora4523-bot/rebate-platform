import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { loadStatusMap } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import * as pipeline from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import * as update from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import * as governance from '../../../../apps/api/src/modules/union/application/order-sync-ports.ts';
import * as userReaders from '../../../../apps/api/src/modules/identity/infra/order-user-reader.ts';
import * as bindingReaders from '../../../../apps/api/src/modules/linking/infra/order-binding-reader.ts';
import { contextOf, runtime, token } from './context-kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-08n#1] worker 装配只注册一次 order-sync，零查询、零投递、零定时器，映射取真实 CSV', async () => {
  vi.useFakeTimers();
  const f = await contextOf('worker', true);
  try {
    const r = await runtime(f.context);
    expect(typeof r.access.queryableAccount).toBe('function');
    expect(f.queue.register.mock.calls.filter(([name]) => name === 'order-sync')).toEqual([
      ['order-sync', expect.any(Function)],
    ]);
    expect(f.queries).toEqual([]);
    expect(f.queue.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const csv = readFileSync(
      new URL('../../../../specs/order-status-map/pdd.csv', import.meta.url),
      'utf8',
    );
    expect([...r.statusMaps('pdd').entries]).toEqual([...loadStatusMap('pdd', csv).entries]);
    expect(r.statusMaps('pdd')).toBe(r.statusMaps('pdd'));
    expect(() => r.statusMaps('jd')).toThrow(
      expect.objectContaining({ code: 'MISSING_STATUS_MAP' }),
    );
    await f.queue.start();
    const handle = r.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.queue.send).not.toHaveBeenCalled();
      expect(f.queries).toEqual([]);
      expect(vi.getTimerCount()).toBe(scheduledPlatforms().length);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.queries).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.queries.some((q) => q.includes('union_accounts'))).toBe(true);
    } finally {
      await handle.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(f.lines().filter((l) => l.msg === 'order_sync_disabled')).toEqual([]);
  } finally {
    await f.context.close();
  }
});

it.each([false, true])(
  '[AC-B1-08n#2] 缺 DB 或队列（onlyQueueMissing=%s）提供 null 并恰一条 info',
  async (onlyQueueMissing) => {
    const key = await token();
    const f = await contextOf('worker', onlyQueueMissing, undefined, onlyQueueMissing);
    try {
      expect(f.context.get(key, { strict: false })).toBeNull();
      expect(f.lines().filter((l) => l.msg === 'order_sync_disabled')).toEqual([
        expect.objectContaining({ level: 30 }),
      ]);
      expect(f.queue.register.mock.calls.filter(([name]) => name === 'order-sync')).toEqual([]);
      expect(f.queries).toEqual([]);
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally {
      await f.context.close();
    }
  },
);

it.each(['api', 'stream', 'admin', 'payout'])('[AC-B1-08n#3] %s 不装配订单同步', async (entry) => {
  const key = await token();
  const f = await contextOf(entry, true);
  try {
    expect(() => f.context.get(key, { strict: false })).toThrow();
    expect(f.queue.register.mock.calls.filter(([name]) => name === 'order-sync')).toEqual([]);
    expect(f.lines().filter((l) => l.msg === 'order_sync_disabled')).toEqual([]);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08n#4] 归因与更新装配共享真实 EVENT_BUS，updateStep 必须注入，mtimeOrdering 默认关闭', async () => {
  const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const makeUsers = vi.spyOn(userReaders, 'createOrderUserReader');
  const makeBindings = vi.spyOn(bindingReaders, 'createOrderBindingReader');
  const makeUnionReaders = vi.spyOn(governance, 'createUnionOrderReaders');
  const f = await contextOf('worker', true);
  try {
    await runtime(f.context);
    expect(makePipeline).toHaveBeenCalledTimes(1);
    expect(makeUpdate).toHaveBeenCalledTimes(1);
    expect(makeUsers).toHaveBeenCalledTimes(1);
    expect(makeBindings).toHaveBeenCalledTimes(1);
    expect(makeUnionReaders).toHaveBeenCalledTimes(1);
    const deps = makePipeline.mock.calls[0]![0];
    const updateDeps = makeUpdate.mock.calls[0]![0];
    const bus = f.context.get(f.platform.EVENT_BUS, { strict: false });
    expect(bus).toMatchObject({ publish: expect.any(Function) });
    expect(deps.events).toBe(bus);
    expect(updateDeps.events).toBe(bus);
    expect(deps.updateStep).toBe(makeUpdate.mock.results[0]!.value);
    expect(deps.mtimeOrdering).toBeUndefined();
    expect(deps.users).toBe(makeUsers.mock.results[0]!.value);
    expect(deps.bindings).toBe(makeBindings.mock.results[0]!.value);
    expect(deps.pids).toBe(makeUnionReaders.mock.results[0]!.value.pids);
    expect(deps.accounts).toBe(makeUnionReaders.mock.results[0]!.value.accounts);
    expect(deps.clock).toBe(f.context.get(f.platform.CLOCK, { strict: false }));
    expect(updateDeps.clock).toBe(deps.clock);
    expect(deps.logger).toBe(f.context.get(f.platform.ROOT_LOGGER, { strict: false }));
    expect(deps.users).toBe(updateDeps.users);
    expect(deps.bindings).toBe(updateDeps.bindings);
    expect(deps.statusMaps).toBe(updateDeps.statusMaps);
    expect(deps.logger).toBe(updateDeps.logger);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08n#21] worker 的处理器 registry 与 access 熔断读取使用同一套治理包装', async () => {
  let state: 'closed' | 'open' = 'closed';
  const govern = vi
    .spyOn(governance, 'createGovernedSyncAdapter')
    .mockImplementation((adapter) => ({
      adapter,
      offlineBreakerState: () => (adapter.platform === 'pdd' ? state : 'closed'),
    }));
  const f = await contextOf('worker', true);
  try {
    const r = await runtime(f.context);
    const index = govern.mock.calls.findIndex(([adapter]) => adapter.platform === 'pdd');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(r.registry.get('pdd')).toBe(govern.mock.results[index]!.value.adapter);
    expect(await r.access.offlineCircuitOpen('pdd')).toBe(false);
    state = 'open';
    expect(await r.access.offlineCircuitOpen('pdd')).toBe(true);
    expect(await r.access.offlineCircuitOpen('jd')).toBe(false);
    state = 'closed';
    expect(await r.access.offlineCircuitOpen('pdd')).toBe(false);
    expect(f.queries).toEqual([]);
  } finally {
    await f.context.close();
  }
});

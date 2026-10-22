import { afterEach, expect, it, vi } from 'vitest';
import * as pipeline from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import * as update from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import * as worker from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import * as retry from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';
import * as commission from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import * as growth from '../../../../apps/api/src/modules/growth/infra/history.ts';
import * as deletion from '../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts';
import { input } from '../../commission/snapshot/fixtures.ts';
import { capture } from '../attribution/kit.ts';
import { built } from '../wiring/db-kit.ts';
import { compileOnlyDb, contextOf, runtime, token } from '../wiring/context-kit.ts';

// URL 导入避免解析器的跨模块类型导出把 Nest 控制器带进 spec 项目编译。
const resolver = (await import(
  new URL(
    '../../../../apps/api/src/modules/commission/infra/beneficiary-resolver.ts',
    import.meta.url,
  ).href
)) as {
  createSnapshotBeneficiaryResolver(options: {
    growth: ReturnType<typeof growth.createGrowthHistory>;
    deletion: ReturnType<typeof deletion.createUserDeletionStatusReader>;
  }): commission.SnapshotBeneficiaryResolver;
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-08w#1] worker 只建一次真实解析器，流水线、更新与补偿共享端口和注入资源', async () => {
  vi.useFakeTimers();
  const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const makeRuntime = vi.spyOn(worker, 'createOrderSyncRuntime');
  const makeResolver = vi.spyOn(resolver, 'createSnapshotBeneficiaryResolver');
  const makeGrowth = vi.spyOn(growth, 'createGrowthHistory');
  const makeDeletion = vi.spyOn(deletion, 'createUserDeletionStatusReader');
  const createSnapshot = vi.spyOn(commission, 'createCommissionSnapshot');
  const scan = vi.spyOn(retry, 'handleSnapshotRetry');
  const queries: string[] = [];
  const db = compileOnlyDb(queries);
  const f = await built(() => contextOf('worker', true, db));
  try {
    await runtime(f.context);
    expect(queries).toEqual([]);
    expect(f.queue.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(makePipeline).toHaveBeenCalledTimes(1);
    expect(makeUpdate).toHaveBeenCalledTimes(1);
    expect(makeRuntime).toHaveBeenCalledTimes(1);
    const deps = makePipeline.mock.calls[0]![0];
    expect(deps.snapshots).toMatchObject({ create: expect.any(Function) });
    const snapshots = deps.snapshots!;
    expect(makeUpdate.mock.calls[0]![0].snapshots).toBe(snapshots);
    const runtimeDeps = makeRuntime.mock.calls[0]![0];
    expect(runtimeDeps.snapshots).toBe(snapshots);
    expect(runtimeDeps.ports).not.toHaveProperty('snapshots');
    expect(makeResolver).toHaveBeenCalledTimes(1);
    expect(makeGrowth).toHaveBeenCalledTimes(1);
    expect(makeDeletion).toHaveBeenCalledTimes(1);
    const beneficiaries = makeResolver.mock.results[0]!.value;
    expect(makeResolver.mock.calls[0]![0].growth).toBe(makeGrowth.mock.results[0]!.value);
    expect(makeResolver.mock.calls[0]![0].deletion).toBe(makeDeletion.mock.results[0]!.value);
    const clock = f.context.get(f.platform.CLOCK, { strict: false });
    const logger = f.context.get(f.platform.ROOT_LOGGER, { strict: false });
    expect(makeGrowth.mock.calls[0]![0].logger).toBe(logger);
    expect(makeDeletion.mock.calls[0]![0].db).toBe(db);
    const request = input({ platform: 'pdd' });
    // DummyDriver 返回空规则库；真实快照函数应返回 pending，无需伪造解析结果。
    await db.transaction().execute(async (trx) => {
      const result = await capture(() => snapshots.create(trx, request));
      expect(result).toMatchObject({ ok: true, value: { kind: 'pending' } });
      expect(createSnapshot).toHaveBeenCalledTimes(1);
      expect(createSnapshot.mock.calls[0]![0]).toBe(trx);
      expect(createSnapshot.mock.calls[0]![1]).toBe(request);
      expect(createSnapshot.mock.calls[0]![2].clock).toBe(clock);
      expect(createSnapshot.mock.calls[0]![2].logger).toBe(logger);
      expect(createSnapshot.mock.calls[0]![2].beneficiaries).toBe(beneficiaries);
    });
    const registrations = f.queue.register.mock.calls.filter(([name]) => name === 'order-sync');
    expect(registrations).toHaveLength(1);
    const job = {
      id: 'synthetic-retry',
      queue: 'order-sync',
      name: 'snapshot-retry',
      payload: { app_id: request.appId },
      attempt: 1,
    };
    expect(await capture(() => registrations[0]![1](job))).toMatchObject({ ok: true });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]![0]).toBe(job);
    expect(scan.mock.calls[0]![1].snapshots).toBe(snapshots);
    expect(scan.mock.calls[0]![1].db).toBe(db);
    expect(scan.mock.calls[0]![1].clock).toBe(clock);
    expect(scan.mock.calls[0]![1].logger).toBe(logger);
    expect(scan.mock.calls[0]![1].events).toBe(runtimeDeps.events);
    expect(queries.some((q) => q.includes('order_sync_pending'))).toBe(true);
    expect(makeResolver).toHaveBeenCalledTimes(1);
    expect(makeGrowth).toHaveBeenCalledTimes(1);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08w#2] 缺资源的 worker 不构造快照解析器，其他入口不装配订单同步与补偿扫描', async () => {
  const key = await token();
  for (const entry of ['worker-no-db', 'worker-no-queue', 'api', 'stream', 'admin', 'payout']) {
    const makeResolver = vi.spyOn(resolver, 'createSnapshotBeneficiaryResolver');
    const makeRuntime = vi.spyOn(worker, 'createOrderSyncRuntime');
    const makeRetryScheduler = vi.spyOn(retry, 'createSnapshotRetryScheduler');
    const isWorker = entry.startsWith('worker');
    const f = await built(() =>
      contextOf(
        isWorker ? 'worker' : entry,
        entry !== 'worker-no-db',
        undefined,
        entry === 'worker-no-queue',
      ),
    );
    try {
      if (isWorker) {
        expect(makeResolver).not.toHaveBeenCalled();
        expect(f.context.get(key, { strict: false })).toBeNull();
        expect(f.lines().filter((l) => l.msg === 'order_sync_disabled')).toEqual([
          expect.objectContaining({ level: 30 }),
        ]);
        expect(f.queries).toEqual([]);
        expect(f.queue.send).not.toHaveBeenCalled();
      } else {
        expect(() => f.context.get(key, { strict: false })).toThrow();
        expect(makeRuntime).not.toHaveBeenCalled();
        expect(makeRetryScheduler).not.toHaveBeenCalled();
      }
      expect(f.queue.register.mock.calls.filter(([name]) => name === 'order-sync')).toEqual([]);
    } finally {
      await f.context.close();
      vi.restoreAllMocks();
    }
  }
  // 正向对照：完全遗漏生产注入不能靠所有禁用分支通过本例。
  const makeResolver = vi.spyOn(resolver, 'createSnapshotBeneficiaryResolver');
  const f = await built(() => contextOf('worker', true));
  try {
    await runtime(f.context);
    expect(makeResolver).toHaveBeenCalledTimes(1);
  } finally {
    await f.context.close();
  }
});

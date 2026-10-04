import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';
import { createPartitionMaintenance, type PartitionMaintenance } from './index.ts';

const instances: PartitionMaintenance[] = [];
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
  vi.useRealTimers();
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(instant = '2026-11-20T03:04:05Z') {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  const control: { respond: (query: CompiledQuery) => Promise<unknown[] | undefined> } = {
    respond: async () => undefined,
  };
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    let rows = await control.respond(query);
    if (rows === undefined) {
      if (query.sql.includes('current_user')) rows = [{ role: 'couli_maint' }];
      else if (query.sql.includes('ensure_month_partition')) {
        rows = [{ partition: `${String(query.parameters[0])}:${String(query.parameters[1])}` }];
      } else if (query.sql.includes('drop_expired_month_partitions')) rows = [{ partitions: [] }];
      else if (query.sql.includes('partition_default_rows')) rows = [];
      else throw new Error('unexpected statement');
    }
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = new FixedClock(instant);
  const now = vi.spyOn(clock, 'now');
  const maintenance = createPartitionMaintenance({
    db,
    logger: logger as unknown as RootLogger,
    clock,
    intervalMs: 100,
  });
  instances.push(maintenance);
  return { maintenance, queries, control, logger, clock, now };
}

it('[AC-B1-01j#1] 独立参数化语句使用同一次时钟读数，失败月份不阻断后续建分区和 DEFAULT 告警', async () => {
  const f = await fixture();
  f.control.respond = async (query) => {
    if (query.sql.includes('ensure_month_partition') && query.parameters[1] === '2026-12-01') {
      throw { code: '23514', message: 'private row data', detail: 'private SQL' };
    }
    if (query.sql.includes('partition_default_rows')) {
      return [
        { table_name: 'event_log', default_partition: 'event_log_default', row_count: 0n },
        { table_name: 'orders', default_partition: 'orders_default', row_count: 3n },
      ];
    }
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(report).toEqual({
    ensured: [
      'event_log:2026-11-01',
      'event_log:2027-01-01',
      'event_log:2027-02-01',
      'orders:2026-11-01',
      'orders:2027-01-01',
      'orders:2027-02-01',
    ],
    dropped: [],
    defaultRows: [{ table: 'orders', partition: 'orders_default', rows: 3 }],
    failed: 2,
  });
  expect(f.queries.map((query) => query.parameters)).toEqual([
    [],
    ['event_log', '2026-11-01'],
    ['event_log', '2026-12-01'],
    ['event_log', '2027-01-01'],
    ['event_log', '2027-02-01'],
    ['orders', '2026-11-01'],
    ['orders', '2026-12-01'],
    ['orders', '2027-01-01'],
    ['orders', '2027-02-01'],
    ['event_log', new Date('2026-11-20T03:04:05Z')],
    [],
  ]);
  expect(f.now).toHaveBeenCalledTimes(1);
  expect(f.logger.error.mock.calls).toEqual(
    ['event_log', 'orders'].map((table) => [
      { table, month: '2026-12-01', sqlstate: '23514' },
      'partition_ensure_failed',
    ]),
  );
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 3 }, 'partition_default_has_rows'],
  ]);
});

it('[AC-B1-01j#2] 删除和 DEFAULT 检查失败分别计数，日志不泄漏错误对象', async () => {
  const f = await fixture();
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions'))
      throw { code: '55P03', detail: 'private' };
    if (query.sql.includes('partition_default_rows')) throw { code: 'secret', message: 'private' };
    return undefined;
  };
  expect(await f.maintenance.runOnce()).toMatchObject({ dropped: [], defaultRows: [], failed: 2 });
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
    [{ sqlstate: null }, 'partition_default_check_failed'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: 8, dropped: 0, failed: 2 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-01j#3] 行数超过安全整数时报告检查失败，不输出舍入后的计数', async () => {
  const f = await fixture();
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          {
            table_name: 'orders',
            default_partition: 'orders_default',
            row_count: 9_007_199_254_740_993n,
          },
        ]
      : undefined;
  expect(await f.maintenance.runOnce()).toMatchObject({ defaultRows: [], failed: 1 });
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: null }, 'partition_default_check_failed'],
  ]);
});

it('[AC-B1-01j#4] 删除门槛跨越北京时间 04:00 与午夜，时钟中途改变不改变本轮参数', async () => {
  const f = await fixture('2026-10-08T19:59:59.999Z');
  expect((await f.maintenance.runOnce()).dropped).toEqual([]);
  expect(f.queries.some((q) => q.sql.includes('drop_expired'))).toBe(false);
  f.clock.set('2026-10-08T20:00:00Z');
  f.control.respond = async (query) => {
    if (query.sql.includes('ensure_month_partition')) f.clock.set('2026-10-09T16:00:00Z');
    return query.sql.includes('drop_expired') ? [{ partitions: ['event_log_p202603'] }] : undefined;
  };
  expect((await f.maintenance.runOnce()).dropped).toEqual(['event_log_p202603']);
  const drops = () => f.queries.filter((q) => q.sql.includes('drop_expired'));
  expect(drops().map((q) => q.parameters)).toEqual([
    ['event_log', new Date('2026-10-08T20:00:00Z')],
  ]);
  expect(f.logger.info).toHaveBeenCalledWith(
    { table: 'event_log', partition: 'event_log_p202603' },
    'partition_dropped',
  );
  await f.maintenance.runOnce();
  expect(drops()).toHaveLength(1);
  expect(f.now).toHaveBeenCalledTimes(3);
});

it('[AC-B1-01j#5] 错误角色立即拒绝，不读时钟不写日志，start 不再安排后续轮次', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.control.respond = async () => [{ role: 'couli_app' }];
  await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'wrong_role' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.queries).toHaveLength(1);
  expect(f.now).not.toHaveBeenCalled();
  expect(f.logger.info).not.toHaveBeenCalled();
  expect(f.logger.error).not.toHaveBeenCalled();
  await expect(f.maintenance.stop()).resolves.toBeUndefined();
});

it('[AC-B1-01j#6] 连接错误由 runOnce 原样抛出，定时运行记录后继续调度', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const error = Object.assign(new Error('private connection data'), { code: 'ECONNREFUSED' });
  f.control.respond = async () => {
    throw error;
  };
  await expect(f.maintenance.runOnce()).rejects.toBe(error);
  await expect(f.maintenance.start()).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: null }, 'partition_maintenance_failed'],
    [{ sqlstate: null }, 'partition_maintenance_failed'],
  ]);
  f.control.respond = async () => undefined;
  await vi.advanceTimersByTimeAsync(100);
  expect(f.logger.info).toHaveBeenCalledWith(
    { ensured: 8, dropped: 0, failed: 0 },
    'partition_maintenance_done',
  );
});

it('[AC-B1-01j#7] 慢轮次不重叠，结束后才计算间隔；stop 等待后续进行中的轮次', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.control.respond = async (query) => {
    if (query.sql.includes('current_user')) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const starting = f.maintenance.start();
  await entered.promise;
  await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'already_started' });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.queries).toHaveLength(1);
  release.resolve();
  await starting;
  const completedQueries = f.queries.length;
  release = Promise.withResolvers<void>();
  await vi.advanceTimersByTimeAsync(99);
  expect(f.queries).toHaveLength(completedQueries);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.queries).toHaveLength(completedQueries + 1);
  const settled = vi.fn();
  const stopping = f.maintenance.stop().then(settled);
  await vi.advanceTimersByTimeAsync(500);
  expect(settled).not.toHaveBeenCalled();
  expect(f.queries).toHaveLength(completedQueries + 1);
  release.resolve();
  await stopping;
  const afterStop = f.queries.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(f.queries).toHaveLength(afterStop);
  expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
});

it.each([false, true])(
  '[AC-B1-01j#8] 首轮阻塞时并发 stop 均等待首轮结束（失败=%s）',
  async (fail) => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.control.respond = async (query) => {
      if (query.sql.includes('current_user')) {
        entered.resolve();
        await release.promise;
        if (fail) throw new Error('connection failed');
      }
      return undefined;
    };
    const starting = f.maintenance.start();
    await entered.promise;
    const stopped = vi.fn();
    const stopping = Promise.all([f.maintenance.stop(), f.maintenance.stop()]).then(stopped);
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await starting;
    await stopping;
    const queryCount = f.queries.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.queries).toHaveLength(queryCount);
    expect(stopped).toHaveBeenCalledExactlyOnceWith([undefined, undefined]);
    await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'already_started' });
  },
);

it('[AC-B1-01j#9] stop 不等待直接调用的 runOnce，停止后仍可手动运行', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.control.respond = async () => {
    entered.resolve();
    await release.promise;
    return undefined;
  };
  const running = f.maintenance.runOnce();
  await entered.promise;
  await expect(f.maintenance.stop()).resolves.toBeUndefined();
  expect(f.logger.info).not.toHaveBeenCalled();
  release.resolve();
  await expect(running).resolves.toMatchObject({ failed: 0 });
  await expect(f.maintenance.runOnce()).resolves.toMatchObject({ failed: 0 });
});

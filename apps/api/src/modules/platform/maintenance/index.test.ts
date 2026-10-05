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
import { createWorkerMaintenance } from './worker.ts';

const instances: PartitionMaintenance[] = [];
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
  vi.useRealTimers();
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(instant = '2026-11-20T03:04:05Z', dayPartitions = false) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  const transactions: { queries: CompiledQuery[]; outcome: string }[] = [];
  let transaction: (typeof transactions)[number] | undefined;
  driver.beginTransaction = async () => {
    if (transaction) throw new Error('overlapping transactions');
    transaction = { queries: [], outcome: 'pending' };
    transactions.push(transaction);
  };
  driver.commitTransaction = async () => {
    transaction!.outcome = 'committed';
    transaction = undefined;
  };
  driver.rollbackTransaction = async () => {
    transaction!.outcome = 'rolled back';
    transaction = undefined;
  };
  const control: { respond: (query: CompiledQuery) => Promise<unknown[] | undefined> } = {
    respond: async () => undefined,
  };
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    transaction?.queries.push(query);
    let rows = await control.respond(query);
    if (rows === undefined) {
      if (query.sql.includes('current_user')) rows = [{ role: 'couli_maint' }];
      else if (/ensure_(month|day)_partition/.test(query.sql)) {
        rows = [{ partition: `${String(query.parameters[0])}:${String(query.parameters[1])}` }];
      } else if (/drop_expired_(month|day)_partitions/.test(query.sql)) rows = [{ partitions: [] }];
      else if (query.sql.includes('partition_default_rows')) rows = [];
      else if (query.sql.includes('set_config')) rows = [];
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
    dayPartitions,
  });
  instances.push(maintenance);
  return { db, maintenance, queries, transactions, control, logger, clock, now };
}

it.each(['23514', '55P03'])(
  '[AC-B1-01s#1] 日预建失败 %s 后完成其余步骤，下一轮重新尝试，日志不泄露错误内容',
  async (code) => {
    const f = await fixture('2026-11-20T03:04:05Z', true);
    f.control.respond = async (query) => {
      if (query.sql.includes('ensure_day_partition') && query.parameters[1] === '2026-11-22') {
        throw { code, message: 'private SQL', detail: 'private row data' };
      }
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    expect(report.failed).toBe(1);
    expect(report.ensured).toHaveLength(code === '55P03' ? 10 : 22);
    expect(f.logger.error.mock.calls).toEqual([
      [{ table: 'link_logs', day: '2026-11-22', sqlstate: code }, 'partition_ensure_failed'],
    ]);
    expect(f.queries.filter((q) => q.sql.includes('ensure_day_partition'))).toHaveLength(
      code === '55P03' ? 3 : 15,
    );
    expect(f.queries.some((q) => q.sql.includes('drop_expired_day_partitions'))).toBe(true);
    expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
    f.control.respond = async () => undefined;
    expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(f.logger.info.mock.calls.at(-1)).toEqual([
      { ensured: 23, dropped: 0, failed: 0 },
      'partition_maintenance_done',
    ]);
    expect(f.now).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ['2026-10-08T19:59:59.999Z', true, false],
  ['2026-10-08T20:00:00.000Z', true, true],
  ['2026-10-08T20:00:00.000Z', false, false],
] as const)(
  '[AC-B1-01s#2] 日删除遵守 04:00 门槛和开关（%s，启用=%s，删除=%s），月删除在前且共用 now',
  async (instant, enabled, shouldDrop) => {
    const f = await fixture(instant, enabled);
    f.control.respond = async (query) => {
      if (query.sql.includes('drop_expired_month_partitions')) {
        return [{ partitions: ['event_log_p202603'] }];
      }
      if (query.sql.includes('drop_expired_day_partitions')) {
        return [{ partitions: ['link_logs_p20260710'] }];
      }
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    const drops = f.queries.filter((q) => q.sql.includes('drop_expired_'));
    expect(drops.filter((q) => q.sql.includes('drop_expired_day_partitions'))).toHaveLength(
      shouldDrop ? 1 : 0,
    );
    if (shouldDrop) {
      expect(drops.map((q) => q.parameters)).toEqual([
        ['event_log', f.now.mock.results[0]!.value],
        ['link_logs', f.now.mock.results[0]!.value],
      ]);
      expect(report.dropped).toEqual(['event_log_p202603', 'link_logs_p20260710']);
      expect(f.logger.info.mock.calls.slice(0, 2)).toEqual([
        [{ table: 'event_log', partition: 'event_log_p202603' }, 'partition_dropped'],
        [{ table: 'link_logs', partition: 'link_logs_p20260710' }, 'partition_dropped'],
      ]);
    }
    expect(report.ensured).toHaveLength(enabled ? 23 : 8);
    expect(f.now).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-01s#3] 日删除锁超时只记一次失败，DEFAULT 仍告警，下一定时轮成功', async () => {
  vi.useFakeTimers();
  const f = await fixture('2026-11-20T03:04:05Z', true);
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_day_partitions')) {
      attempts += 1;
      if (attempts === 1) throw { code: '55P03', detail: 'private row data' };
      return [{ partitions: ['link_logs_p20260710'] }];
    }
    if (query.sql.includes('partition_default_rows')) {
      return [{ table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 1n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(attempts).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'link_logs', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
    { table: 'link_logs', partition: 'link_logs_default', rows: 1 },
    'partition_default_has_rows',
  );
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: 23, dropped: 0, failed: 1 },
    'partition_maintenance_done',
  ]);
  await vi.advanceTimersByTimeAsync(100);
  expect(attempts).toBe(2);
  expect(f.logger.error).toHaveBeenCalledTimes(1);
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: 23, dropped: 1, failed: 0 },
    'partition_maintenance_done',
  ]);
});

it('[AC-B1-01n#5] worker 对 link_logs 降为信息日志，报告仍包含它，orders 仍告警', async () => {
  const f = await fixture();
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          { table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 2n },
          { table_name: 'orders', default_partition: 'orders_default', row_count: 3n },
          { table_name: 'event_log', default_partition: 'event_log_default', row_count: 0n },
        ]
      : undefined;
  const worker = createWorkerMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
  });
  instances.push(worker);
  const report = await worker.runOnce();
  expect(report.defaultRows).toEqual([
    { table: 'link_logs', partition: 'link_logs_default', rows: 2 },
    { table: 'orders', partition: 'orders_default', rows: 3 },
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [report.defaultRows[0], 'partition_default_rows_expected'],
    [{ ensured: 8, dropped: 0, failed: 0 }, 'partition_maintenance_done'],
  ]);
  expect(f.logger.warn.mock.calls).toEqual([[report.defaultRows[1], 'partition_default_has_rows']]);
});

it('[AC-B1-01n#6] 创建后修改 quietDefaultTables 不影响日志分级', async () => {
  const f = await fixture();
  const tables = ['link_logs'];
  const maintenance = createPartitionMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
    quietDefaultTables: tables,
  });
  instances.push(maintenance);
  tables.splice(0, 1, 'orders');
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          { table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 1n },
          { table_name: 'orders', default_partition: 'orders_default', row_count: 1n },
        ]
      : undefined;
  await maintenance.runOnce();
  expect(f.logger.info).toHaveBeenCalledWith(
    { table: 'link_logs', partition: 'link_logs_default', rows: 1 },
    'partition_default_rows_expected',
  );
  expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
    { table: 'orders', partition: 'orders_default', rows: 1 },
    'partition_default_has_rows',
  );
});

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
  expect(f.queries.filter((q) => !q.sql.includes('set_config')).map((q) => q.parameters)).toEqual([
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
  expect(f.transactions.map((transaction) => transaction.outcome)).toEqual([
    'committed',
    'rolled back',
    'committed',
    'committed',
    'committed',
    'rolled back',
    'committed',
    'committed',
    'committed',
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

it('[AC-B1-01j#10] 删除锁超时只记一次失败，继续 DEFAULT 告警，下一轮重试成功', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions')) {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: '55P03',
          message: 'canceling statement due to lock timeout',
          detail: 'private connection and row data',
        };
      }
      return [{ partitions: ['event_log_p202603'] }];
    }
    if (query.sql.includes('partition_default_rows')) {
      return [{ table_name: 'orders', default_partition: 'orders_default', row_count: 2n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(attempts).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 2 }, 'partition_default_has_rows'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: 8, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  await vi.advanceTimersByTimeAsync(99);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toBe(2);
  expect(f.logger.error).toHaveBeenCalledTimes(1);
  expect(f.logger.info.mock.calls.slice(1)).toEqual([
    [{ table: 'event_log', partition: 'event_log_p202603' }, 'partition_dropped'],
    [{ ensured: 8, dropped: 1, failed: 0 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-01j#11] stop 等待中的删除收到锁超时后完成，且不再调度', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions')) {
      entered.resolve();
      await release.promise;
      throw { code: '55P03', message: 'canceling statement due to lock timeout' };
    }
    return undefined;
  };
  const starting = f.maintenance.start();
  await entered.promise;
  const stopped = vi.fn();
  const stopping = f.maintenance.stop().then(stopped);
  await vi.advanceTimersByTimeAsync(100);
  expect(stopped).not.toHaveBeenCalled();
  release.resolve();
  await starting;
  await stopping;
  expect(stopped).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: 8, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
  const queryCount = f.queries.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.queries).toHaveLength(queryCount);
});

it('[AC-B1-01j#12] 每次预建和 DEFAULT 计数独占短事务，首句设置事务级 5 秒锁超时', async () => {
  const f = await fixture();
  expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
  const boundedQueries = f.queries.filter(
    (q) => q.sql.includes('ensure_month_partition') || q.sql.includes('partition_default_rows'),
  );
  expect(boundedQueries).toHaveLength(9);
  expect(f.transactions).toHaveLength(9);
  for (const [index, transaction] of f.transactions.entries()) {
    expect(transaction.outcome).toBe('committed');
    expect(transaction.queries).toHaveLength(2);
    expect(transaction.queries[0]?.sql).toBe("SELECT set_config('lock_timeout', '5s', true)");
    expect(transaction.queries[1]).toBe(boundedQueries[index]);
  }
});

it.each([['event_log'], ['event_log', 'orders']])(
  '[AC-B1-01j#13] 锁超时每表只失败一次，跳过剩余月份、其他表继续，下轮重新预建（%j）',
  async (...blockedTables) => {
    const f = await fixture();
    f.control.respond = async (query) => {
      if (
        query.sql.includes('ensure_month_partition') &&
        blockedTables.includes(String(query.parameters[0])) &&
        query.parameters[1] === '2027-01-01'
      ) {
        throw { code: '55P03', message: 'private SQL', detail: 'private row data' };
      }
      return undefined;
    };
    const allNames = ['event_log', 'orders'].flatMap((table) =>
      ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'].map((month) => `${table}:${month}`),
    );
    expect(await f.maintenance.runOnce()).toEqual({
      ensured: allNames.filter(
        (name) => !blockedTables.some((table) => name.startsWith(`${table}:2027`)),
      ),
      dropped: [],
      defaultRows: [],
      failed: blockedTables.length,
    });
    expect(f.logger.error.mock.calls).toEqual(
      blockedTables.map((table) => [
        { table, month: '2027-01-01', sqlstate: '55P03' },
        'partition_ensure_failed',
      ]),
    );
    expect(
      f.queries
        .filter(
          (q) =>
            q.sql.includes('ensure_month_partition') &&
            blockedTables.includes(String(q.parameters[0])),
        )
        .some((q) => q.parameters[1] === '2027-02-01'),
    ).toBe(false);
    expect(f.transactions.filter((t) => t.outcome === 'rolled back')).toHaveLength(
      blockedTables.length,
    );
    expect(f.queries.some((q) => q.sql.includes('drop_expired_month_partitions'))).toBe(true);
    expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
    f.control.respond = async () => undefined;
    expect(await f.maintenance.runOnce()).toEqual({
      ensured: allNames,
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
  },
);

it('[AC-B1-01j#14] DEFAULT 锁超时回滚并记一次失败，下一定时轮恢复计数告警', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('partition_default_rows')) {
      attempts += 1;
      if (attempts === 1) throw { code: '55P03', detail: 'private row data' };
      return [{ table_name: 'orders', default_partition: 'orders_default', row_count: 2n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(f.transactions.at(-1)?.outcome).toBe('rolled back');
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: '55P03' }, 'partition_default_check_failed'],
  ]);
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: 8, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  await vi.advanceTimersByTimeAsync(99);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toBe(2);
  expect(f.transactions.at(-1)?.outcome).toBe('committed');
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 2 }, 'partition_default_has_rows'],
  ]);
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: 8, dropped: 0, failed: 0 },
    'partition_maintenance_done',
  ]);
});

it.each(['ensure_month_partition', 'partition_default_rows'])(
  '[AC-B1-01j#15] stop 等待 %s 锁超时后完成回滚，不再调度',
  async (functionName) => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.control.respond = async (query) => {
      if (query.sql.includes(functionName)) {
        entered.resolve();
        await release.promise;
        throw { code: '55P03' };
      }
      return undefined;
    };
    const starting = f.maintenance.start();
    await entered.promise;
    const stopped = vi.fn();
    const stopping = f.maintenance.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await starting;
    await stopping;
    expect(stopped).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.transactions.every((t) => t.outcome !== 'pending')).toBe(true);
    expect(f.transactions.filter((t) => t.outcome === 'rolled back')).toHaveLength(
      functionName === 'ensure_month_partition' ? 2 : 1,
    );
    const queryCount = f.queries.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.queries).toHaveLength(queryCount);
  },
);

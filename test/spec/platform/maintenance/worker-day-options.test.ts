// Unit rule tests of worker 契约 8.1 and 8.2 (task B1-01w; the contract is written in the header of
// ./worker-day-partitions.int.test.ts). Basis: ADR-0001 §4.2 第 4 项 (按日的表预建未来 14 天; DEFAULT 分区
// 有数据即告警), 第 5 项 (link_logs 按日). createPartitionMaintenance of ./index.ts is replaced by a spy
// that calls the real function, so the exact options the worker passes are visible; no database, no
// port. Top-level it() only (规划/11 §4.3).
import { expect, it, vi } from 'vitest';

import * as maintenanceModule from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import type { PartitionMaintenanceOptions } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import * as workerModule from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { countingClock, describeError, memoryLogger, thrownProblems } from './kit.ts';

vi.mock(
  '../../../../apps/api/src/modules/platform/maintenance/index.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/platform/maintenance/index.ts')
      >();
    return { ...actual, createPartitionMaintenance: vi.fn(actual.createPartitionMaintenance) };
  },
);

const spy = vi.mocked(maintenanceModule.createPartitionMaintenance);

/** What createPartitionMaintenance was called with during `run`, and what `run` gave back. */
function observe(run: () => unknown): { calls: unknown[][]; result: unknown; returned: unknown[] } {
  spy.mockClear();
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    result = describeError(error);
  }
  return {
    calls: spy.mock.calls.map((args) => [...args]),
    result,
    returned: spy.mock.results.map((r) => (r.type === 'return' ? r.value : r.type)),
  };
}

it('[ADR-0001 §4.2 #4 按日的表预建未来 14 天、DEFAULT 分区有数据即告警; worker 契约 8.1、8.2] createWorkerMaintenance 只调用一次 createPartitionMaintenance，参数是一个普通对象：给定的 db / logger / clock（同一对象）与 intervalMs（只在给了时），加 dayPartitions: true，没有 quietDefaultTables；返回的就是它返回的那个实例；创建时不读时钟、不写日志；worker.ts 不再导出 WORKER_QUIET_DEFAULT_TABLES', () => {
  const outcomes: unknown[] = [];
  const expected: unknown[] = [];
  for (const extra of [{}, { intervalMs: 100 }] as const) {
    const db = {};
    const clock = countingClock('2026-11-20T03:04:05Z');
    const { logger, lines } = memoryLogger();
    const seen = observe(() =>
      workerModule.createWorkerMaintenance({
        db,
        logger,
        clock,
        ...extra,
      } as unknown as PartitionMaintenanceOptions),
    );
    const arg = seen.calls[0]?.[0];
    outcomes.push({
      calls: seen.calls.length,
      args: seen.calls[0]?.length,
      plain:
        arg !== null && typeof arg === 'object' && Object.getPrototypeOf(arg) === Object.prototype,
      keys: arg !== null && typeof arg === 'object' ? Reflect.ownKeys(arg).map(String).sort() : arg,
      same:
        arg !== null && typeof arg === 'object'
          ? {
              db: (arg as Record<string, unknown>)['db'] === db,
              logger: (arg as Record<string, unknown>)['logger'] === logger,
              clock: (arg as Record<string, unknown>)['clock'] === clock,
            }
          : null,
      dayPartitions: (arg as Record<string, unknown> | undefined)?.['dayPartitions'],
      intervalMs: (arg as Record<string, unknown> | undefined)?.['intervalMs'],
      returnsIt: seen.returned.length === 1 && seen.result === seen.returned[0],
      clock: clock.calls(),
      lines: lines.length,
    });
    expected.push({
      calls: 1,
      args: 1,
      plain: true,
      keys:
        'intervalMs' in extra
          ? ['clock', 'dayPartitions', 'db', 'intervalMs', 'logger']
          : ['clock', 'dayPartitions', 'db', 'logger'],
      same: { db: true, logger: true, clock: true },
      dayPartitions: true,
      intervalMs: 'intervalMs' in extra ? 100 : undefined,
      returnsIt: true,
      clock: 0,
      lines: 0,
    });
  }
  expect({
    outcomes,
    quietExported: Object.prototype.hasOwnProperty.call(
      workerModule,
      'WORKER_QUIET_DEFAULT_TABLES',
    ),
  }).toEqual({ outcomes: expected, quietExported: false });
});

it('[worker 契约 8.2] 多出的键一律同步抛 invalid_option 且不调用 createPartitionMaintenance：quietDefaultTables（[]、[link_logs]）、dayPartitions（true、false）、未知键', () => {
  const base = {
    db: {},
    logger: memoryLogger().logger,
    clock: countingClock('2026-11-20T03:04:05Z'),
  };
  const bad: Record<string, Record<string, unknown>> = {
    quietEmpty: { ...base, quietDefaultTables: [] },
    quietLinkLogs: { ...base, quietDefaultTables: ['link_logs'] },
    dayTrue: { ...base, dayPartitions: true },
    dayFalse: { ...base, dayPartitions: false },
    unknownKey: { ...base, tables: ['link_logs'] },
  };
  const seen: Record<string, unknown> = {};
  for (const [label, options] of Object.entries(bad)) {
    spy.mockClear();
    const problems = thrownProblems(
      () => workerModule.createWorkerMaintenance(options as unknown as PartitionMaintenanceOptions),
      'invalid_option',
    );
    seen[label] = { problems, calls: spy.mock.calls.length };
  }
  expect(seen).toEqual(
    Object.fromEntries(Object.keys(bad).map((label) => [label, { problems: [], calls: 0 }])),
  );
});

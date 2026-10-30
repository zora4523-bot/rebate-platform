// Unit rule tests of the purge tick and of the internal queue's place outside the catalog (B1-15za;
// contract sections 1 and 2 of apps/api/src/modules/platform/queue/idempotency-purge.ts). No
// database runs: the runtime's db handle points at a closed port and is never connected.
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb } from '@couli/db';
import { expect, it, vi } from 'vitest';
import {
  runIdempotencyPurge,
  scheduleIdempotencyPurge,
} from '../../../../apps/api/src/modules/platform/queue/idempotency-purge.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
  createQueueRuntime,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { memoryLogger, reduceLine, settled, thrown } from '../queue/kit.ts';
import { QUEUE, purgedLine } from './kit.ts';

it('[AC-B1-15za#4] 内部队列不在业务目录里：目录与入口计划都没有它，业务代码登记处理器或发送都得 unknown_queue', async () => {
  const db = createDb({ connectionString: 'postgres://couli_app@127.0.0.1:1/unused', max: 1 });
  try {
    const worker = createQueueRuntime({
      entry: 'worker',
      db,
      logger: memoryLogger('worker').logger,
    });
    scheduleIdempotencyPurge(worker, { purgeExpired: async () => 0 });
    expect(QUEUE_CATALOG.map((spec) => spec.name)).not.toContain(QUEUE);
    expect(
      Object.values(ENTRY_PLAN)
        .flat()
        .map((work) => work.queue),
    ).not.toContain(QUEUE);
    expect(thrown(() => worker.register(QUEUE, async () => undefined))).toBe(
      'QueueError unknown_queue',
    );
    expect(await settled(worker.send(QUEUE, 'idempotency.purge', {}, { trx: null }))).toBe(
      'QueueError unknown_queue',
    );
    await worker.stop();
  } finally {
    await destroyDb(db);
  }
});

it('[AC-B1-15za#5] 一次清理调用 purgeExpired 一次，只记一行删除行数，字段恰好是 deleted；删 0 行也记', async () => {
  for (const deleted of [3, 0]) {
    const { logger, lines } = memoryLogger('worker');
    const purgeExpired = vi.fn(async () => deleted);
    await expect(
      runIdempotencyPurge({ idempotency: { purgeExpired }, logger }),
    ).resolves.toBeUndefined();
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => reduceLine(line))).toEqual([purgedLine(deleted)]);
  }
});

it('[AC-B1-15za#6] purgeExpired 失败时同一错误原样抛出，这次清理自己不记日志（错误里可能带参数）', async () => {
  const { logger, lines } = memoryLogger('worker');
  const failure = new Error('driver detail with parameters');
  const purgeExpired = vi.fn(async () => {
    throw failure;
  });
  await expect(runIdempotencyPurge({ idempotency: { purgeExpired }, logger })).rejects.toBe(
    failure,
  );
  expect(purgeExpired).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([]);
});

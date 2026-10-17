import { expect, it } from 'vitest';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/catalog.ts';

it('[AC-B1-08g#22] order-sync 紧邻 order-rescan 之前，exclusive、默认重试与单一死信', () => {
  // Project the existing catalog into values before asserting: a missing entry is an
  // assertion failure, never an undefined dereference / TypeError in the red phase.
  const sync = QUEUE_CATALOG.filter((q) => q.name === 'order-sync');
  expect(sync).toEqual([
    {
      name: 'order-sync',
      policy: 'exclusive',
      retryLimit: 5,
      retryDelaySeconds: 10,
      retryBackoff: true,
      retryDelayMaxSeconds: 600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      deadLetter: 'dead-letter',
    },
  ]);
  const names = QUEUE_CATALOG.map((q) => q.name);
  expect(names.indexOf('order-rescan')).toBe(names.indexOf('order-sync') + 1);
  expect(
    QUEUE_CATALOG.filter((q) => q.name === 'dead-letter').map((q) => ({
      retryLimit: q.retryLimit,
      deadLetter: q.deadLetter,
    })),
  ).toEqual([{ retryLimit: 0, deadLetter: null }]);
});

it('[AC-B1-08g#23] worker 第一位以并发 1 消费 order-sync，其他入口不消费', () => {
  const first = ENTRY_PLAN.worker.slice(0, 1);
  expect(first).toEqual([{ queue: 'order-sync', concurrency: 1, pollingIntervalSeconds: 2 }]);
  expect(ENTRY_PLAN.worker.filter((w) => w.queue === 'order-sync')).toHaveLength(1);
  const other = ['api', 'stream', 'admin', 'payout'] as const;
  expect(
    other.flatMap((entry) => ENTRY_PLAN[entry].filter((w) => w.queue === 'order-sync')),
  ).toEqual([]);
  expect(ENTRY_PLAN.worker.some((w) => w.queue === 'dead-letter')).toBe(false);
});

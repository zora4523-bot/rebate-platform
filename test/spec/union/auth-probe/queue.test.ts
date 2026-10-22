import { expect, it } from 'vitest';
import * as union from '../../../../apps/api/src/modules/union/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';

it('[AC-S1-64#50] union-auth 是 exclusive，只 worker 并发1，其余目录默认；公共出口队列名固定', () => {
  expect((union as unknown as Record<string, unknown>)['UNION_AUTH_QUEUE']).toBe('union-auth');
  expect(QUEUE_CATALOG.filter((q) => q.name === 'union-auth')).toEqual([
    {
      name: 'union-auth',
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
  expect(ENTRY_PLAN.worker.filter((q) => q.queue === 'union-auth')).toEqual([
    { queue: 'union-auth', concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].filter((q) => q.queue === 'union-auth')).toEqual([]);
  }
});

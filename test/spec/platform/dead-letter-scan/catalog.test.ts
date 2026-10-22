import { expect, it } from 'vitest';
import { createDb, destroyDb } from '@couli/db';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
  createQueueRuntime,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { BUSINESS_QUEUES, capture } from './kit.ts';

it('[AC-B1-01zzg#1] 每个业务队列指向唯一的同名 .dead，死信零重试保留 30 天且所有入口均禁止消费', async () => {
  const db = createDb({ connectionString: 'postgres://couli_app@127.0.0.1:1/unused', max: 1 });
  try {
    for (const name of BUSINESS_QUEUES) {
      expect(QUEUE_CATALOG.filter((q) => q.name === name).map((q) => q.deadLetter)).toEqual([
        `${name}.dead`,
      ]);
      expect(QUEUE_CATALOG.filter((q) => q.name === `${name}.dead`)).toEqual([
        {
          name: `${name}.dead`,
          policy: 'standard',
          retryLimit: 0,
          retryDelaySeconds: 1,
          retryBackoff: false,
          retryDelayMaxSeconds: null,
          expireInSeconds: 900,
          retentionSeconds: 2_592_000,
          deleteAfterSeconds: 2_592_000,
          deadLetter: null,
        },
      ]);
      for (const entry of ['api', 'stream', 'admin', 'worker', 'payout'] as const) {
        expect(ENTRY_PLAN[entry].some((work) => work.queue === `${name}.dead`)).toBe(false);
        expect(() =>
          createQueueRuntime({
            entry,
            db,
            logger: capture().logger,
            plan: {
              ...ENTRY_PLAN,
              [entry]: [
                ...ENTRY_PLAN[entry],
                { queue: `${name}.dead`, concurrency: 1, pollingIntervalSeconds: 2 },
              ],
            },
          }),
        ).toThrow(expect.objectContaining({ code: 'invalid_catalog' }));
      }
    }
    expect(QUEUE_CATALOG.some((q) => q.deadLetter === 'dead-letter')).toBe(false);
    for (const queue of QUEUE_CATALOG.filter((q) => q.deadLetter !== null)) {
      expect(queue.deadLetter).toBe(`${queue.name}.dead`);
    }
  } finally {
    await destroyDb(db);
  }
});

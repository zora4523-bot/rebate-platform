import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { CONSUMER, NOW, QUEUE } from './fixtures.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';

it('[AC-B1-12p#22] appeal.resolved 有生产订阅和 standard 事件队列，仅 worker 消费', () => {
  expect(EVENT_SUBSCRIPTIONS.filter((sub) => sub.consumer === CONSUMER)).toEqual([
    { consumer: CONSUMER, events: ['appeal.resolved'] },
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toEqual([
    expect.objectContaining({ name: QUEUE, policy: 'standard' }),
  ]);
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toEqual([
    { queue: QUEUE, concurrency: 5, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].filter((work) => work.queue === QUEUE)).toEqual([]);
  }
});

it('[AC-B1-12p#23] 真 AppModule 只在 worker 注册一次消费者，启动装配不发消息不查业务库', async () => {
  const queries: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(query) {
      queries.push(query.query.sql);
    },
  });
  try {
    for (const entry of ['worker', 'api', 'stream', 'admin', 'payout']) {
      const app = await assembled(entry, db, new FixedClock(NOW));
      try {
        expect(
          app.registrations.filter((registration) => registration.name === QUEUE),
        ).toHaveLength(entry === 'worker' ? 1 : 0);
        expect(app.sends).not.toHaveBeenCalled();
        expect(queries).toEqual([]);
      } finally {
        await app.close();
      }
    }
  } finally {
    await db.destroy();
  }
});

import { expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/catalog.ts';

it('[AC-B1-12r#23] claim.resolved 有且仅有一个本任务订阅，队列及 worker 计划完整且其他进程不消费', () => {
  expect(EVENT_SUBSCRIPTIONS.filter((s) => s.consumer === 'notification-claim-result')).toEqual([
    { consumer: 'notification-claim-result', events: ['claim.resolved'] },
  ]);
  expect(QUEUE_CATALOG.filter((q) => q.name === 'evt.notification-claim-result')).toMatchObject([
    { name: 'evt.notification-claim-result', policy: 'standard', deadLetter: 'dead-letter' },
  ]);
  expect(ENTRY_PLAN.worker.filter((w) => w.queue === 'evt.notification-claim-result')).toEqual([
    { queue: 'evt.notification-claim-result', concurrency: 5, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].filter((w) => w.queue === 'evt.notification-claim-result')).toEqual(
      [],
    );
  }
});

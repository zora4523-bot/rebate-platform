// B2-07e queue rule test (claude-independent, SPEC_REF 37808a50): task §9.3 / D10-428 — the W11
// attempt records go through their own queue `payout-attempt-append`, registered in the
// production catalog (with its `.dead` queue, settings as every business queue and its dead
// letter queue) and worked only by the payout process (couli_payout), concurrency 1; no other
// entry works it. Unit test: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';

/** The payout process's queue of the W11 attempt records (task §9.3). */
const ATTEMPT_QUEUE = 'payout-attempt-append';

it('[AC-B2-07e#15] 队列目录登记 payout-attempt-append（exclusive，重试同其他业务队列，死信进 payout-attempt-append.dead）与它的死信队列；只有 payout 入口计划消费它，并发 1，api / stream / admin / worker 都不消费', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === ATTEMPT_QUEUE)).toStrictEqual([
    {
      name: ATTEMPT_QUEUE,
      policy: 'exclusive',
      retryLimit: 5,
      retryDelaySeconds: 10,
      retryBackoff: true,
      retryDelayMaxSeconds: 600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      deadLetter: `${ATTEMPT_QUEUE}.dead`,
    },
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === `${ATTEMPT_QUEUE}.dead`)).toStrictEqual([
    {
      name: `${ATTEMPT_QUEUE}.dead`,
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
  expect(ENTRY_PLAN.payout.filter((work) => work.queue === ATTEMPT_QUEUE)).toStrictEqual([
    { queue: ATTEMPT_QUEUE, concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  expect(
    (['api', 'stream', 'admin', 'worker'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === ATTEMPT_QUEUE).map(() => entry),
    ),
  ).toStrictEqual([]);
});

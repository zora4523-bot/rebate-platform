import type { EntryPlan, QueueSpec, WorkSpec } from './types.ts';

const defaults = {
  policy: 'standard',
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
  deadLetter: 'dead-letter',
} as const;

export const QUEUE_CATALOG: readonly QueueSpec[] = Object.freeze([
  ...['order-rescan', 'settle', 'payout', 'notify', 'pool-refresh', 'poster', 'agent-trace'].map(
    (name): QueueSpec =>
      Object.freeze({
        ...defaults,
        name,
        policy: name === 'settle' || name === 'payout' ? 'exclusive' : 'standard',
      }),
  ),
  Object.freeze({
    name: 'dead-letter',
    policy: 'standard',
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 900,
    retentionSeconds: 2_592_000,
    deleteAfterSeconds: 2_592_000,
    deadLetter: null,
  }),
]);

const work = (queue: string, concurrency: number, pollingIntervalSeconds = 2): WorkSpec =>
  Object.freeze({ queue, concurrency, pollingIntervalSeconds });

export const ENTRY_PLAN: EntryPlan = Object.freeze({
  api: Object.freeze([]),
  stream: Object.freeze([]),
  admin: Object.freeze([]),
  worker: Object.freeze([
    work('order-rescan', 1),
    work('settle', 1),
    work('notify', 5),
    work('pool-refresh', 1),
    work('poster', 2, 0.5),
    work('agent-trace', 2),
  ]),
  payout: Object.freeze([work('payout', 1)]),
});

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
  ...[
    'order-sync',
    'order-rescan',
    'settle',
    'payout',
    'notify',
    // Site union authorization check chain, its probe retry, expiry and alert delivery jobs
    // (B1-22b): union's UnionAuthModule, worker only; one queued or active job per singletonKey.
    'union-auth',
    // Event queue of notification's risk.state_changed consumer (B1-12g); events/types.ts.
    'evt.notification-risk-state',
    // Event queue of notification's appeal.resolved consumer (B1-12p); events/types.ts.
    'evt.notification-appeal-result',
    // Event queue of notification's claim.resolved consumer (B1-12r); events/types.ts.
    'evt.notification-claim-result',
    // Event queue of payout's account.went_negative consumer (B2-05e, BR-WDR-05 (a)); events/types.ts.
    'evt.payout-went-negative',
    // Payment jobs (B2-15b; handlers B2-15c / B2-15d): order.query, order.close of payment's
    // PaymentModule, worker only. Exclusive: one queued or active job per singletonKey
    // (`order.query:<pay_order_id>:returned`, `order.close:<pay_order_id>`), which is how a
    // repeated client return or cancel enqueues nothing more (task §9.8 / §9.9).
    'pay',
    'pool-refresh',
    // Scheduled page publish due jobs (F1-09p): content's ContentWorkerModule, worker only.
    'page-schedule',
    'poster',
    'agent-trace',
    'risk-scan',
    // Admin data exports (B1-34c / B1-34e): generate and delayed expire jobs of export_tasks.
    'export',
  ].map((name): QueueSpec =>
    Object.freeze({
      ...defaults,
      name,
      // risk-scan (B1-03j): at most one queued or active job per time-slot singletonKey.
      // order-sync (B1-08g): one queued or active job per window singletonKey (02 §7.1).
      policy:
        name === 'order-sync' ||
        name === 'settle' ||
        name === 'payout' ||
        name === 'risk-scan' ||
        name === 'union-auth' ||
        name === 'pay'
          ? 'exclusive'
          : 'standard',
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
    work('order-sync', 1),
    work('order-rescan', 1),
    work('settle', 1),
    work('notify', 5),
    work('union-auth', 1),
    work('evt.notification-risk-state', 5),
    work('evt.notification-appeal-result', 5),
    work('evt.notification-claim-result', 5),
    // One worker: the member's withdrawals are re-checked under the users lock, serially.
    work('evt.payout-went-negative', 1),
    // B2-15b: payment's queue, worker only, four slots (task §9.10).
    work('pay', 4),
    work('pool-refresh', 1),
    work('page-schedule', 1),
    work('poster', 2, 0.5),
    work('agent-trace', 2),
    work('export', 1),
    work('risk-scan', 1),
  ]),
  payout: Object.freeze([work('payout', 1)]),
});

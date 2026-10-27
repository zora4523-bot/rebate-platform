import type { EntryPlan, QueueSpec, WorkSpec } from './types.ts';
import { WORKER_LANES } from './worker-plan.ts';

const defaults = {
  policy: 'standard',
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
} as const;

const BUSINESS_QUEUES = [
  'order-sync',
  'order-rescan',
  'settle',
  'payout',
  // The worker's landing of a payout result (B2-06fz, D10-326 C): one job per success / fail
  // attempt, singletonKey `${withdrawal_id}:${execute_seq}:land:${attempt_id}`.
  'payout-landing',
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
  // Event queue of payout's withdrawal.created consumer (B2-11c, BR-WDR-30); events/types.ts.
  'evt.payout-auto-payout',
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
  // Personal information copies (B1-27h, BR-ID-40): generate and delayed expire jobs of
  // identity's personal_data_copies, worker only.
  'data-copy',
  'agent-trace',
  'risk-scan',
  // Admin data exports (B1-34c / B1-34e): generate and delayed expire jobs of export_tasks.
  'export',
] as const;

/** B1-01zzg (D10-183 ② R-01): every business queue <q> dead-letters into its own <q>.dead. */
const deadLetterOf = (name: string): string => `${name}.dead`;

export const QUEUE_CATALOG: readonly QueueSpec[] = Object.freeze([
  ...BUSINESS_QUEUES.map((name): QueueSpec =>
    Object.freeze({
      ...defaults,
      name,
      // risk-scan (B1-03j): at most one queued or active job per time-slot singletonKey.
      // order-sync (B1-08g): one queued or active job per window singletonKey (02 §7.1).
      policy:
        name === 'order-sync' ||
        name === 'settle' ||
        name === 'payout' ||
        name === 'payout-landing' ||
        name === 'risk-scan' ||
        name === 'union-auth' ||
        name === 'pay'
          ? 'exclusive'
          : 'standard',
      deadLetter: deadLetterOf(name),
    }),
  ),
  // The dead letter queues, in the order of their sources (order-sync.dead first). No entry works
  // them (validation.ts): failed jobs wait there for an operator; the worker's dead letter scan
  // (dead-letter-scan.ts) only counts them. Settings of the former global `dead-letter` queue,
  // which is no longer in the catalog (its row stays in the database; nothing points at it).
  ...BUSINESS_QUEUES.map((name): QueueSpec =>
    Object.freeze({
      name: deadLetterOf(name),
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
  ),
]);

const work = (queue: string, concurrency: number, pollingIntervalSeconds = 2): WorkSpec =>
  Object.freeze({ queue, concurrency, pollingIntervalSeconds });

export const ENTRY_PLAN: EntryPlan = Object.freeze({
  api: Object.freeze([]),
  stream: Object.freeze([]),
  admin: Object.freeze([]),
  worker: Object.freeze(
    WORKER_LANES.map(([queue, concurrency, polling]) => work(queue, concurrency, polling)),
  ),
  payout: Object.freeze([work('payout', 1)]),
});

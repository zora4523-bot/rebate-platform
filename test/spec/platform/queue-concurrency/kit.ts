// Shared values of the B1-01zzk rule tests (worker queue concurrency limits: contract section 12 of
// apps/api/src/modules/platform/queue/index.ts, apps/api/src/modules/platform/config/queue-concurrency.ts).
// Every expected value is written out by hand from the task brief and the trunk, never read from
// the implementation. Nothing here imports the test-database base (`@couli/db/testing`).
import type {
  EntryPlan,
  QueueSpec,
  WorkSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { TEST_DEAD, spec } from '../queue/kit.ts';

export function w(queue: string, concurrency: number, pollingIntervalSeconds = 2): WorkSpec {
  return { queue, concurrency, pollingIntervalSeconds };
}

/** ENTRY_PLAN.worker of the trunk (task brief, 现状), in order: 19 queues, 40 slots together. */
export const TRUNK_WORKER_PLAN: readonly WorkSpec[] = [
  w('order-sync', 1),
  w('order-rescan', 1),
  w('settle', 1),
  // B2-06fz (D10-326 取 C; D10-376): the worker lands W5 / W6, right after settle.
  w('payout-landing', 1),
  w('notify', 5),
  w('union-auth', 1),
  w('evt.notification-risk-state', 5),
  w('evt.notification-appeal-result', 5),
  w('evt.notification-claim-result', 5),
  // B2-11c (BR-WDR-30): payout's withdrawal.created consumer, one slot, before went-negative.
  w('evt.payout-auto-payout', 1),
  w('evt.payout-went-negative', 1),
  w('pay', 4),
  w('pool-refresh', 1),
  w('page-schedule', 1),
  w('poster', 2, 0.5),
  w('data-copy', 1),
  w('agent-trace', 2),
  w('export', 1),
  w('risk-scan', 1),
];

/** ENTRY_PLAN of the trunk: only the worker and payout work queues; payout 1 (规划/02 §3.1). */
export const TRUNK_ENTRY_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: TRUNK_WORKER_PLAN,
  payout: [w('payout', 1)],
};

/** Business queues of the trunk catalog, in catalog order. */
const TRUNK_BUSINESS_QUEUES = [
  'order-sync',
  'order-rescan',
  'settle',
  'payout',
  'payout-landing',
  'notify',
  'union-auth',
  'evt.notification-risk-state',
  'evt.notification-appeal-result',
  'evt.notification-claim-result',
  'evt.payout-auto-payout',
  'evt.payout-went-negative',
  'pay',
  'pool-refresh',
  'page-schedule',
  'poster',
  'data-copy',
  'agent-trace',
  'risk-scan',
  'export',
] as const;

const TRUNK_EXCLUSIVE: ReadonlySet<string> = new Set([
  'order-sync',
  'settle',
  'payout',
  'payout-landing',
  'risk-scan',
  'union-auth',
  'pay',
]);

/** QUEUE_CATALOG of the trunk: the business queues, then their `.dead` queues in the same order. */
export const TRUNK_CATALOG: readonly QueueSpec[] = [
  ...TRUNK_BUSINESS_QUEUES.map((name): QueueSpec => ({
    name,
    policy: TRUNK_EXCLUSIVE.has(name) ? 'exclusive' : 'standard',
    retryLimit: 5,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetter: `${name}.dead`,
  })),
  ...TRUNK_BUSINESS_QUEUES.map((name): QueueSpec => ({
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
  })),
];

/** The default shared budget of the worker: floor(POOL_SIZES.worker.db 10 × 0.7). */
export const DEFAULT_DB_BUDGET = 7;
/** Connections of the worker's pool kept for supervision and health checks (task brief 取值 3). */
export const RESERVED_CONNECTIONS = 3;

/** QUEUE_CONCURRENCY_<Q> of each worker queue: upper case, '-' and '.' replaced by '_'. */
export const ENV_NAME_OF: Readonly<Record<string, string>> = {
  'order-sync': 'QUEUE_CONCURRENCY_ORDER_SYNC',
  'order-rescan': 'QUEUE_CONCURRENCY_ORDER_RESCAN',
  settle: 'QUEUE_CONCURRENCY_SETTLE',
  'payout-landing': 'QUEUE_CONCURRENCY_PAYOUT_LANDING',
  notify: 'QUEUE_CONCURRENCY_NOTIFY',
  'union-auth': 'QUEUE_CONCURRENCY_UNION_AUTH',
  'evt.notification-risk-state': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_RISK_STATE',
  'evt.notification-appeal-result': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_APPEAL_RESULT',
  'evt.notification-claim-result': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_CLAIM_RESULT',
  'evt.payout-auto-payout': 'QUEUE_CONCURRENCY_EVT_PAYOUT_AUTO_PAYOUT',
  'evt.payout-went-negative': 'QUEUE_CONCURRENCY_EVT_PAYOUT_WENT_NEGATIVE',
  pay: 'QUEUE_CONCURRENCY_PAY',
  'pool-refresh': 'QUEUE_CONCURRENCY_POOL_REFRESH',
  'page-schedule': 'QUEUE_CONCURRENCY_PAGE_SCHEDULE',
  poster: 'QUEUE_CONCURRENCY_POSTER',
  'data-copy': 'QUEUE_CONCURRENCY_DATA_COPY',
  'agent-trace': 'QUEUE_CONCURRENCY_AGENT_TRACE',
  export: 'QUEUE_CONCURRENCY_EXPORT',
  'risk-scan': 'QUEUE_CONCURRENCY_RISK_SCAN',
};

/** The shared budget variable. */
export const BUDGET_ENV = 'QUEUE_DB_BUDGET';

function work(queue: string, concurrency: number): WorkSpec {
  return { queue, concurrency, pollingIntervalSeconds: 0.5 };
}

/**
 * Catalog of the runtime tests: three standard worker queues `c-a`, `c-b`, `c-c`, the payout
 * entry's `c-pay` and the dead letter queue of ../queue/kit.ts (expiry 60 s: nothing expires).
 */
export const LIMIT_CATALOG: readonly QueueSpec[] = [
  spec('c-a'),
  spec('c-b'),
  spec('c-c'),
  spec('c-pay'),
  TEST_DEAD,
];

/** Worker c-a 4 + c-b 4 + c-c 2 = 10 slots (the worker pool's size); payout c-pay 3. */
export const LIMIT_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: [work('c-a', 4), work('c-b', 4), work('c-c', 2)],
  payout: [work('c-pay', 3)],
};

/** queue → concurrency of a plan's items. */
export function concurrencyOf(items: readonly WorkSpec[]): Record<string, number> {
  return Object.fromEntries(items.map((item) => [item.queue, item.concurrency]));
}

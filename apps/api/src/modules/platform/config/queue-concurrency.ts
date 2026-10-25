// Concurrency limits of the worker's job queues (B1-01zzk; platform/queue/index.ts section 12).
// Pure: only looks at the given object; a problem names the variable, never its value.
//
// - QUEUE_CONCURRENCY_<Q> for each queue <q> of ENTRY_PLAN.worker, <Q> being the queue name in
//   upper case with every '-' and '.' replaced by '_' (order-sync → QUEUE_CONCURRENCY_ORDER_SYNC,
//   evt.notification-risk-state → QUEUE_CONCURRENCY_EVT_NOTIFICATION_RISK_STATE): decimal digits
//   only, an integer from 1 to that queue's plan concurrency. It can only lower the plan.
// - A QUEUE_CONCURRENCY_* variable that names no queue of ENTRY_PLAN.worker (a typo; payout, whose
//   concurrency 1 is fixed (规划/02 §3.1) and which only the payout entry works; a dead letter
//   queue) is a problem as well.
// - QUEUE_DB_BUDGET: decimal digits only, an integer from 1 to 7 (POOL_SIZES.worker.db 10 minus the
//   3 connections kept for supervision and health checks). Unset: the runtime's default 7.
// - '' counts as unset, like every variable of loadConfig. Every APP_ENV reads them the same way;
//   every entry loads them, only the worker uses them.
// - Problems: one per bad variable, starting with its name (`QUEUE_DB_BUDGET: …`). loadConfig
//   throws one ConfigError listing them together with every other problem (also when APP_ENV
//   itself is invalid).
// - Result: `queueLimits` null when none of these variables is set; else { concurrency: each set
//   queue → its value, dbBudget: the value or null }. loadConfig puts it into AppConfig.queueLimits
//   only when it is not null, so the shape of an unconfigured result does not change.
import { WORKER_DB_BUDGET, WORKER_LANES, type QueueLimits } from '../queue/worker-plan.ts';

const CONCURRENCY_PREFIX = 'QUEUE_CONCURRENCY_';
const BUDGET_ENV = 'QUEUE_DB_BUDGET';

/** QUEUE_CONCURRENCY_<Q> → [queue, plan concurrency] for each queue of ENTRY_PLAN.worker. */
const WORKER_QUEUES: ReadonlyMap<string, readonly [string, number]> = new Map(
  WORKER_LANES.map(([queue, concurrency]) => [
    `${CONCURRENCY_PREFIX}${queue.toUpperCase().replace(/[-.]/g, '_')}`,
    [queue, concurrency] as const,
  ]),
);

/** Decimal digits only, from 1 to `max`; else null. */
function bounded(value: string, max: number): number | null {
  if (!/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= max ? parsed : null;
}

export interface QueueConcurrencyConfigResult {
  readonly queueLimits: QueueLimits | null;
  readonly problems: readonly string[];
}

export function readQueueConcurrencyConfig(
  env: Readonly<Record<string, string | undefined>>,
): QueueConcurrencyConfigResult {
  const problems: string[] = [];
  const concurrency: Record<string, number> = {};
  let set = false;
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(CONCURRENCY_PREFIX) || value === undefined || value === '') continue;
    const queue = WORKER_QUEUES.get(name);
    if (queue === undefined) {
      problems.push(`${name}: names no queue of the worker entry`);
      continue;
    }
    const parsed = bounded(value, queue[1]);
    if (parsed === null) {
      problems.push(`${name}: must be an integer from 1 to ${String(queue[1])}`);
      continue;
    }
    concurrency[queue[0]] = parsed;
    set = true;
  }
  let dbBudget: number | null = null;
  const budget = env[BUDGET_ENV];
  if (budget !== undefined && budget !== '') {
    dbBudget = bounded(budget, WORKER_DB_BUDGET);
    if (dbBudget === null) {
      problems.push(`${BUDGET_ENV}: must be an integer from 1 to ${String(WORKER_DB_BUDGET)}`);
    } else {
      set = true;
    }
  }
  if (problems.length > 0) return { queueLimits: null, problems };
  // Keys in ENTRY_PLAN.worker order, independent of the environment's order.
  const ordered: Record<string, number> = {};
  for (const [queue] of WORKER_QUEUES.values()) {
    if (Object.hasOwn(concurrency, queue)) ordered[queue] = concurrency[queue]!;
  }
  return { queueLimits: set ? { concurrency: ordered, dbBudget } : null, problems: [] };
}

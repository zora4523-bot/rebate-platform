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
import type { QueueLimits } from '../queue/types.ts';

export interface QueueConcurrencyConfigResult {
  readonly queueLimits: QueueLimits | null;
  readonly problems: readonly string[];
}

export function readQueueConcurrencyConfig(
  env: Readonly<Record<string, string | undefined>>,
): QueueConcurrencyConfigResult {
  void env;
  throw new Error('NotImplemented: readQueueConcurrencyConfig');
}

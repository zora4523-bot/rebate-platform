// Effective concurrency of an entry's lanes (B1-01zzk; contract section 12 of ./index.ts).
import type { EntryName } from '../entries.ts';
import { WORKER_DB_BUDGET } from './worker-plan.ts';
import { QueueError, type EffectiveLimits, type EntryPlan, type QueueLimits } from './types.ts';
import { integer, keys, plain } from './validation.ts';

/** Section 12's shape of `limits`, checked against plan.worker without invoking getters. */
function validLimits(plan: EntryPlan, limits: unknown): limits is QueueLimits {
  if (!keys(limits, ['concurrency', 'dbBudget'])) return false;
  const { concurrency, dbBudget } = limits;
  if (dbBudget !== null && !integer(dbBudget, 1, WORKER_DB_BUDGET)) return false;
  // Every own key must be an enumerable data property: accessors and hidden keys are refused.
  if (!plain(concurrency) || !keys(concurrency, Object.keys(concurrency), [])) return false;
  const planned = new Map(plan.worker.map((item) => [item.queue, item.concurrency]));
  return Object.entries(concurrency).every(([queue, value]) => {
    const max = planned.get(queue);
    return max !== undefined && integer(value, 1, max);
  });
}

/**
 * The concurrency each queue of `plan[entry]` runs with and the entry's shared budget. Pure: reads
 * `plan` and `limits`, changes neither. Throws QueueError('invalid_option') for limits that break
 * section 12 (checked against plan.worker for every entry).
 */
export function effectiveLimits(
  entry: EntryName,
  plan: EntryPlan,
  limits?: QueueLimits,
): EffectiveLimits {
  if (limits !== undefined && !validLimits(plan, limits)) throw new QueueError('invalid_option');
  const worker = entry === 'worker';
  const overrides: Readonly<Record<string, number>> = worker ? (limits?.concurrency ?? {}) : {};
  return {
    concurrency: Object.fromEntries(
      plan[entry].map((item) => [
        item.queue,
        Object.hasOwn(overrides, item.queue) ? overrides[item.queue]! : item.concurrency,
      ]),
    ),
    dbBudget: worker ? (limits?.dbBudget ?? WORKER_DB_BUDGET) : null,
  };
}

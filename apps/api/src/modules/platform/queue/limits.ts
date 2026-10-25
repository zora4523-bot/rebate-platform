// Effective concurrency of an entry's lanes (B1-01zzk; contract section 12 of ./index.ts).
import type { EntryName } from '../entries.ts';
import type { EffectiveLimits, EntryPlan, QueueLimits } from './types.ts';

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
  void entry;
  void plan;
  void limits;
  throw new Error('NotImplemented: effectiveLimits');
}

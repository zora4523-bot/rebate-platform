// Calendar arithmetic of the asset daily snapshot (BR-FUND-18), on @couli/domain primitives only:
// the run at D+1 00:01 +08:00 writes D, and D's snapshot is late from D+1 00:30 +08:00 on.
import { accountingDate, chinaDayRange } from '@couli/domain';
import { LedgerError } from './errors.ts';

const MS_PER_DAY = 86_400_000;
/** BR-FUND-18: the snapshot waits until 00:30 of D+1 at the latest. */
const DEADLINE_AFTER_MIDNIGHT_MS = 30 * 60_000;

/** A copy of `at` moved by `ms` (no `new Date(`; the input is never modified). */
function shifted(at: Date, ms: number): Date {
  const copy = structuredClone(at);
  copy.setTime(at.getTime() + ms);
  return copy;
}

/**
 * D of a nominal run time: the +08:00 calendar day before the day of `nominalRunAt`. The nominal
 * time is kept on delayed delivery, so a late or replayed run still writes its own D.
 * +08:00 has no daylight saving, so one day back is exactly 24 hours.
 */
export function snapshotDayOf(nominalRunAt: Date): string {
  if (!(nominalRunAt instanceof Date) || !Number.isFinite(nominalRunAt.getTime())) {
    throw new LedgerError('INVALID_INPUT', 'nominalRunAt must be a valid Date');
  }
  return accountingDate(shifted(nominalRunAt, -MS_PER_DAY));
}

/** Epoch milliseconds of D+1 00:30 +08:00, the deadline of D's snapshot. */
export function snapshotDeadlineMs(day: string): number {
  let end: string;
  try {
    end = chinaDayRange(day).end;
  } catch (error) {
    throw new LedgerError('INVALID_INPUT', `invalid accounting date ${JSON.stringify(day)}`, {
      cause: error,
    });
  }
  return Date.parse(end) + DEADLINE_AFTER_MIDNIGHT_MS;
}

/** Whether `now` is at or past D's deadline (00:30:00.000 itself is late). */
export function isPastDeadline(now: Date, day: string): boolean {
  return now.getTime() >= snapshotDeadlineMs(day);
}

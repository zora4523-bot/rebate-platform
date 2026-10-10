// Time slots of the risk-scan job chain (B1-03j; orchestrator ruling §9.3 #2). A slot names the
// moment a job is due, so the job that is running and the next one it enqueues never share a
// singletonKey, while every worker that seeds or continues the same slot computes the same key:
// - freeze-expiry: one slot per UTC minute, key `freeze-expiry:YYYY-MM-DDTHH:mm`;
// - daily-alerts: one slot per +08:00 calendar day, key `daily-alerts:YYYY-MM-DD`, due at 00:05.
// Pure functions of the instant handed in (the caller reads the injected Clock).

export type RiskScanJobName = 'freeze-expiry' | 'daily-alerts';

export interface RiskScanSlot {
  readonly singletonKey: string;
  /** Seconds until the slot is due; at least 1. Absent for a seed of the current slot. */
  readonly delaySeconds?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** +08:00 has no daylight saving time: a fixed offset. */
const OFFSET_MS = 8 * 3_600_000;
/** daily-alerts is due five minutes into the +08:00 day. */
const DAILY_DUE_MS = 5 * MINUTE_MS;

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
export function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function minuteKey(like: Date, ms: number): string {
  return `freeze-expiry:${dateAt(like, ms).toISOString().slice(0, 16)}`;
}

function dayKey(like: Date, ms: number): string {
  return `daily-alerts:${dateAt(like, ms + OFFSET_MS)
    .toISOString()
    .slice(0, 10)}`;
}

function delayUntil(due: number, now: number): number {
  return Math.max(1, Math.ceil((due - now) / 1000));
}

/** The slot `now` falls in: what a worker seeds at startup (due at once, no delay). */
export function currentRiskScanSlot(name: RiskScanJobName, now: Date): RiskScanSlot {
  const ms = now.getTime();
  return { singletonKey: name === 'freeze-expiry' ? minuteKey(now, ms) : dayKey(now, ms) };
}

/** The first slot after the one `now` falls in, with the delay until it is due. */
export function nextRiskScanSlot(name: RiskScanJobName, now: Date): RiskScanSlot {
  const ms = now.getTime();
  if (name === 'freeze-expiry') {
    const due = Math.floor(ms / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    return { singletonKey: minuteKey(now, due), delaySeconds: delayUntil(due, ms) };
  }
  const dayStart = Math.floor((ms + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;
  const due = dayStart + DAY_MS + DAILY_DUE_MS;
  return { singletonKey: dayKey(now, due), delaySeconds: delayUntil(due, ms) };
}

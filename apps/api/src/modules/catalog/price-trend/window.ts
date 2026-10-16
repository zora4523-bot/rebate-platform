/** Natural days at fixed +08:00, independent of the host timezone. */
export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
const OFFSET_MS = 8 * 3_600_000;

export function dayNumber(epochMs: number): number {
  return Math.floor((epochMs + OFFSET_MS) / DAY_MS);
}

/** Derive a Date from the injected instant without reading the system clock. */
export function dateAt(now: Date, epochMs: number): Date {
  const date = structuredClone(now);
  date.setTime(epochMs);
  return date;
}

export function windowStart(now: Date): Date {
  return dateAt(now, (dayNumber(now.getTime()) - WINDOW_DAYS + 1) * DAY_MS - OFFSET_MS);
}

export function dayLabel(now: Date, day: number): string {
  return dateAt(now, day * DAY_MS).toISOString().slice(0, 10);
}

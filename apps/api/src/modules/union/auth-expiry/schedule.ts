// Pure time and node rules of the site authorization check (B1-22b; BR-ID-24 ①②, task §9 判定口径).
// Functions of the instants handed in (the caller reads the injected Clock); +08:00 is a fixed
// offset (no daylight saving time).
//
// - union.auth_alert_days: an array of integers 1–999, deduplicated and sorted descending; a
//   missing value, an empty array or any other element makes the whole value the default.
// - union.auth_probe_cron: only the daily form `m h * * *` (+08:00); anything else is invalid.
// - Remaining days = the +08:00 date of auth_expires_at − the +08:00 date of the latest check
//   time at or before now (a run before today's check time counts as yesterday's check).

export interface ProbeTime {
  readonly hour: number;
  readonly minute: number;
}

export const DEFAULT_ALERT_DAYS: readonly number[] = Object.freeze([14, 7, 1]);
export const DEFAULT_PROBE_TIME: ProbeTime = Object.freeze({ hour: 9, minute: 0 });

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;
const CRON = /^([0-9]{1,2}) ([0-9]{1,2}) \* \* \*$/;
const STAGE = /^d([1-9][0-9]{0,2})$/;

/** The alert nodes of a config value, or null when the value is not a valid node list. */
export function parseAlertDays(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const nodes = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 999) return null;
    nodes.add(item);
  }
  return Object.freeze([...nodes].sort((a, b) => b - a));
}

/** The daily check time of a config value, or null when it is not `m h * * *`. */
export function parseProbeCron(value: unknown): ProbeTime | null {
  if (typeof value !== 'string') return null;
  const match = CRON.exec(value.trim());
  if (match === null) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  return Object.freeze({ hour, minute });
}

function timeOfDayMs(time: ProbeTime): number {
  return (time.hour * 60 + time.minute) * MINUTE_MS;
}

/** Days since the epoch of the +08:00 calendar date of `ms`. */
export function beijingDay(ms: number): number {
  return Math.floor((ms + OFFSET_MS) / DAY_MS);
}

/** The +08:00 day of the latest check time at or before `nowMs`. */
export function checkDay(nowMs: number, time: ProbeTime): number {
  const day = beijingDay(nowMs);
  const within = nowMs + OFFSET_MS - day * DAY_MS;
  return within >= timeOfDayMs(time) ? day : day - 1;
}

/** Remaining days of an authorization expiring at `expiresMs`, judged at `nowMs`. */
export function remainingDays(expiresMs: number, nowMs: number, time: ProbeTime): number {
  return beijingDay(expiresMs) - checkDay(nowMs, time);
}

/** The first check time strictly after `nowMs`: its instant and its +08:00 minute label. */
export function nextCheckSlot(
  nowMs: number,
  time: ProbeTime,
): { readonly dueMs: number; readonly label: string } {
  let due = beijingDay(nowMs) * DAY_MS - OFFSET_MS + timeOfDayMs(time);
  if (due <= nowMs) due += DAY_MS;
  return {
    dueMs: due,
    label: `${dayLabel(beijingDay(due))}T${pad(time.hour)}:${pad(time.minute)}`,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD of a day count since the epoch (proleptic Gregorian, civil-from-days). */
function dayLabel(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

/** The node of a `d<N>` stage, or null for none / expired / anything else. */
export function stageNode(stage: string): number | null {
  const match = STAGE.exec(stage);
  return match === null ? null : Number(match[1]);
}

/** The smallest node already reached (remaining ≤ node), or null. */
export function reachedNode(remaining: number, nodes: readonly number[]): number | null {
  let reached: number | null = null;
  for (const node of nodes)
    if (remaining <= node && (reached === null || node < reached)) reached = node;
  return reached;
}

/**
 * The node to alert now: the smallest reached node, when the stage is none or that node is
 * smaller than the node already alerted (skipped nodes are never sent late). Else null.
 */
export function dueNode(remaining: number, nodes: readonly number[], stage: string): number | null {
  const node = reachedNode(remaining, nodes);
  if (node === null) return null;
  if (stage === 'none') return node;
  const sent = stageNode(stage);
  return sent !== null && node < sent ? node : null;
}

/** expiring once the remaining days reach the largest node, active before. */
export function statusFor(remaining: number, nodes: readonly number[]): 'active' | 'expiring' {
  return nodes.length > 0 && remaining <= Math.max(...nodes) ? 'expiring' : 'active';
}

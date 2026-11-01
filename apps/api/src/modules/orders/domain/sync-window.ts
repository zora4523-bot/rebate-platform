// B1-08g: pure window arithmetic for incremental order sync (规划/02 §7.1). No Nest, no I/O.
import type { RegisteredPlatform } from '../../union/index.ts';
import { PLATFORM_RULES } from './platform-rules/index.ts';

function windowCaps(): Partial<Record<RegisteredPlatform, number>> {
  const caps: Partial<Record<RegisteredPlatform, number>> = {};
  for (const platform of Object.keys(PLATFORM_RULES) as RegisteredPlatform[]) {
    const cap = PLATFORM_RULES[platform].syncWindowCapMs;
    if (cap !== null) caps[platform] = cap;
  }
  return caps;
}

/**
 * Increment window cap per platform (02 §7.1 table), read from the rule table's syncWindowCapMs.
 * Fixed today for Jingdong (60 minutes) and Pinduoduo (30 minutes); a platform without an entry
 * is not scheduled.
 */
// TODO(规划/11 §4.5): 淘宝增量窗口上限与 scene 分路 — blocked on CAP-TB-07
export const INCREMENT_WINDOW_CAP_MS: Readonly<Partial<Record<RegisteredPlatform, number>>> =
  Object.freeze(windowCaps());

export const DEFAULT_SYNC_INTERVAL_SECONDS = 60;

/** Platforms the scheduler dispatches increment windows for. */
export function scheduledPlatforms(): readonly RegisteredPlatform[] {
  return Object.keys(INCREMENT_WINDOW_CAP_MS) as RegisteredPlatform[];
}

/** Parses an ISO instant to epoch ms; throws on anything that is not a valid date. */
export function parseInstantMs(value: unknown, field: string): number {
  if (typeof value !== 'string' || value === '') throw new TypeError(`invalid ${field}`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`invalid ${field}`);
  return ms;
}

/** A Date at `ms` without constructing one from the wall clock (apps/api Clock rule). */
export function instantAt(like: Date, ms: number): Date {
  const at = structuredClone(like);
  at.setTime(ms);
  return at;
}

/** ISO string of `ms`, millisecond precision. */
export function isoAt(like: Date, ms: number): string {
  return instantAt(like, ms).toISOString();
}

/**
 * Next continuous window [start, min(start + cap, now)); null when it would be empty or
 * negative. Bounds come back as ISO strings with milliseconds.
 */
export function nextWindow(
  startMs: number,
  now: Date,
  capMs: number,
): { readonly window_start: string; readonly window_end: string } | null {
  const end = Math.min(startMs + capMs, now.getTime());
  if (end <= startMs) return null;
  return { window_start: isoAt(now, startMs), window_end: isoAt(now, end) };
}

/** Queue singletonKey: platform:account:kind:scene:window_start (02 §7.1). */
export function windowSingletonKey(w: {
  readonly platform: string;
  readonly union_account_id: string;
  readonly query_kind: string;
  readonly scene: string;
  readonly window_start: string;
}): string {
  return `${w.platform}:${w.union_account_id}:${w.query_kind}:${w.scene}:${w.window_start}`;
}

/** Interval config value: a positive integer number of seconds, else the default. */
export function intervalSeconds(configured: unknown): number {
  const n =
    typeof configured === 'string' && configured.trim() !== '' ? Number(configured) : configured;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    ? n
    : DEFAULT_SYNC_INTERVAL_SECONDS;
}

/** B1-04zm: how long after now − days a round starts. */
export const RESCAN_START_MARGIN_MS = 3_600_000;

const DAY_MS = 86_400_000;
const RESCAN_MAX_DAYS = 90;
const RESCAN_MIN_INTERVAL_SECONDS = 60;

/** B1-04zm: a rescan days value: an integer in 1～90 (the adapters take only 90 days back). */
export function isRescanDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= RESCAN_MAX_DAYS
  );
}

/** B1-04zm: what a rescan stream does next: one full window, or the end of this round. */
export type RescanStep =
  | { readonly kind: 'window'; readonly startMs: number; readonly endMs: number }
  | { readonly kind: 'round_end'; readonly restartMs: number };

/**
 * B1-04zm: the next step from a rescan cursor (规划/02 §7.1). A round starts at
 * now − days + RESCAN_START_MARGIN_MS (one hour, every platform and days): the adapters judge
 * from ≥ now − 90 days in milliseconds when the job runs, which is always after it was sent. An
 * absent cursor or one older than that start begins there; less than one full window left before
 * the round's end ends the round, restarting there. Windows are always exactly capMs long.
 * ceilingMs is where the round ends when that is before now (min(now, increment cursor), D10-545);
 * absent → now. It moves only the end: the start always counts from nowMs.
 */
export function rescanStep(
  cursorMs: number | null,
  nowMs: number,
  days: number,
  capMs: number,
  ceilingMs?: number,
): RescanStep {
  const roundStartMs = nowMs - days * DAY_MS + RESCAN_START_MARGIN_MS;
  const roundEndMs = Math.min(nowMs, ceilingMs ?? nowMs);
  const startMs = cursorMs === null || cursorMs < roundStartMs ? roundStartMs : cursorMs;
  if (startMs + capMs > roundEndMs) return { kind: 'round_end', restartMs: roundStartMs };
  return { kind: 'window', startMs, endMs: startMs + capMs };
}

/**
 * B1-04zm: seconds between rounds of one stream: 24 hours ÷ (days ÷ cap) windows, at least 60. The
 * start margin does not enter: 30 days of 60-minute windows stay 120 seconds.
 */
export function rescanIntervalSeconds(days: number, capMs: number): number {
  // 86400 s ÷ (days × 86400000 ms ÷ capMs) reduces to capMs ÷ (days × 1000). Floored, so a round
  // never takes longer than a day because of rounding.
  return Math.max(RESCAN_MIN_INTERVAL_SECONDS, Math.floor(capMs / (days * 1000)));
}

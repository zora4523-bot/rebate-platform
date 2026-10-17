// B1-08g: pure window arithmetic for incremental order sync (规划/02 §7.1). No Nest, no I/O.
import type { RegisteredPlatform } from '../../union/index.ts';

/**
 * Increment window cap per platform (02 §7.1 table). Only Pinduoduo is fixed today (30 minutes);
 * a platform without an entry is not scheduled.
 */
// TODO(规划/11 §4.5): 淘宝 / 京东增量窗口上限与 scene 分路 — blocked on CAP-TB-07 / CAP-JD-07
export const INCREMENT_WINDOW_CAP_MS: Readonly<Partial<Record<RegisteredPlatform, number>>> =
  Object.freeze({ pdd: 30 * 60_000 });

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

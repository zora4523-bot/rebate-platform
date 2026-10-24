// B2-15d: the pure part of the close flow's rhythm (08 BR-PAY-05 ②③ and 细则 · 关单; task §9.2,
// §9.3, §9.6). No clock, no database: instants and raw configuration values come in as arguments.
// Also compiled by the `test` project: erasable syntax only.

const MS_PER_MINUTE = 60_000;

/** Code defaults of BR-PAY-05 细则 · 关单; config_items of the same key overrides each. */
export const CLOSE_GRACE_MINUTES_KEY = 'pay.close_grace_minutes';
export const CLOSE_RETRY_MINUTES_KEY = 'pay.close_retry_minutes';
export const CLOSE_WAIT_MINUTES_KEY = 'pay.close_wait_minutes';
export const DEFAULT_CLOSE_GRACE_MINUTES = 10;
export const DEFAULT_CLOSE_RETRY_MINUTES = 5;
export const DEFAULT_CLOSE_WAIT_MINUTES = 60;

/**
 * A minutes value from config_items: a positive safe integer is used as is; absent (null or
 * undefined) is the default without fallback; anything else is the default with fallback true
 * (the caller alerts).
 */
export function closeMinutesOf(
  raw: unknown,
  defaultMinutes: number,
): { readonly minutes: number; readonly fallback: boolean } {
  if (raw === null || raw === undefined) return { minutes: defaultMinutes, fallback: false };
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return { minutes: raw, fallback: false };
  }
  return { minutes: defaultMinutes, fallback: true };
}

/** The three close settings in effect, in minutes. */
export interface CloseSettings {
  readonly graceMinutes: number;
  readonly retryMinutes: number;
  readonly waitMinutes: number;
}

/** expire_at moved by whole minutes (a copy: the given instant is never modified). */
export function afterExpire(expireAt: Date, minutes: number): Date {
  return shiftedMs(expireAt, minutes * MS_PER_MINUTE);
}

function shiftedMs(base: Date, ms: number): Date {
  // No `new Date(` in app code: a copy of a given instant, moved.
  const at = structuredClone(base);
  at.setTime(base.getTime() + ms);
  return at;
}

/**
 * «单据不存在» may be taken as closed only from expire_at + grace on, and only on a query made at
 * or after that instant (BR-PAY-05 ②; task §9.2 now ≥ expire_at + grace).
 */
export function notExistMayClose(now: Date, expireAt: Date, settings: CloseSettings): boolean {
  return now.getTime() >= afterExpire(expireAt, settings.graceMinutes).getTime();
}

/** At expire_at + wait the automatic flow stops: needs_manual (BR-PAY-05 ③). */
export function closeWaitOver(now: Date, expireAt: Date, settings: CloseSettings): boolean {
  return now.getTime() >= afterExpire(expireAt, settings.waitMinutes).getTime();
}

/**
 * The next run of a close flow still without a result: the first instant strictly after now on
 * the grid expire_at + k × retry (k any integer, so a run before expire_at — a user's cancel — is
 * on the same grid), and never later than expire_at + wait (the needs_manual point) nor, while a
 * «not exist» is waiting for its grace, than expire_at + grace. Every chain of the same order
 * lands on the same instants, so the singletonKey built from the instant merges a cancel chain
 * and an expiry chain into one.
 */
export function nextCloseRunAt(
  now: Date,
  expireAt: Date,
  settings: CloseSettings,
  waitingGrace: boolean,
): Date {
  const retryMs = settings.retryMinutes * MS_PER_MINUTE;
  const k = Math.floor((now.getTime() - expireAt.getTime()) / retryMs) + 1;
  let next = shiftedMs(expireAt, k * retryMs);
  const bounds = [afterExpire(expireAt, settings.waitMinutes)];
  if (waitingGrace) bounds.push(afterExpire(expireAt, settings.graceMinutes));
  for (const bound of bounds) {
    if (bound.getTime() > now.getTime() && bound.getTime() < next.getTime()) next = bound;
  }
  return next;
}

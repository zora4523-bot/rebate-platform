// Values and pure calculations of the SMS code rules (规划/08 BR-ID-05 and its 细则「短信验证码与注册
// 风控」). 08 has no configuration keys for these numbers (orchestrator ruling B1-02e §9.3 #11);
// only the prefix blocklist is read from configuration (sms.blocked_prefixes).
//
// Per phone number (normalised), over login / bind / step_up together and across apps, counting
// only SMS the provider accepted (or whose outcome is unknown, ruling §9.5 #1):
//   - 1 per 60 s, from the moment the previous one was accepted;
//   - 5 per natural hour and 10 per natural day, both in +08:00;
//   - protection until CAP-X-09 settles the channel's day window: 10 per sliding 24 hours.
// A request that hits several limits waits for the latest release (Retry-After).
// A code is 6 digits, valid 300 seconds from acceptance, kept per (app, phone, purpose), replaced by
// the next accepted code of the same key, consumed by a successful check, void after 5 wrong tries.
//
// Also compiled by the `test` project: erasable syntax only, no imports.

export const SMS_CODE_DIGITS = 6;
export const SMS_CODE_LIFETIME_SECONDS = 300;
export const SMS_CODE_MAX_ERRORS = 5;

export const SMS_RESEND_INTERVAL_MS = 60_000;
export const SMS_PER_NATURAL_HOUR = 5;
export const SMS_PER_NATURAL_DAY = 10;
export const SMS_PER_ROLLING_WINDOW = 10;
export const SMS_ROLLING_WINDOW_MS = 86_400_000;

/** Retry-After when the quota store cannot answer (BR-TEXT-14 client default; ruling §9.5 #5). */
export const SMS_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** Configuration key of the prefix blocklist (BR-ID-05), read per app. */
export const SMS_BLOCKED_PREFIXES_KEY = 'sms.blocked_prefixes';
/**
 * 08 default of sms.blocked_prefixes (170, 171, 162, 165, 167), as prefixes of the normalised
 * number in E.164 form (ruling §9.5 #8).
 */
export const SMS_DEFAULT_BLOCKED_PREFIXES: readonly string[] = Object.freeze([
  '+86170',
  '+86171',
  '+86162',
  '+86165',
  '+86167',
]);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** +08:00, the time zone of the natural hour and day (BR-ID-05). */
const OFFSET_MS = 8 * HOUR_MS;

/** Start and end (exclusive) of the natural hour and day around `nowMs`, in epoch milliseconds. */
export interface NaturalWindows {
  readonly hourStartMs: number;
  readonly nextHourMs: number;
  readonly dayStartMs: number;
  readonly nextDayMs: number;
}

function floorTo(nowMs: number, unitMs: number): number {
  const local = nowMs + OFFSET_MS;
  return nowMs - (((local % unitMs) + unitMs) % unitMs);
}

export function naturalWindows(nowMs: number): NaturalWindows {
  const hourStartMs = floorTo(nowMs, HOUR_MS);
  const dayStartMs = floorTo(nowMs, DAY_MS);
  return {
    hourStartMs,
    nextHourMs: hourStartMs + HOUR_MS,
    dayStartMs,
    nextDayMs: dayStartMs + DAY_MS,
  };
}

/** Whole seconds from `nowMs` until `releaseMs`, rounded up; at least 1 (Retry-After ≥ 1). */
export function secondsUntil(releaseMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((releaseMs - nowMs) / 1000));
}

/** The normalised 11-digit number in E.164 form, as the prefixes are written. */
export function e164(phone: string): string {
  return `+86${phone}`;
}

/** True when the E.164 form of the normalised number starts with one of the prefixes. */
export function isBlockedPrefix(phone: string, prefixes: readonly string[]): boolean {
  const full = e164(phone);
  return prefixes.some((prefix) => full.startsWith(prefix));
}

const PREFIX = /^\+[0-9]{1,15}$/;

/**
 * The prefixes of a sms.blocked_prefixes value: a JSON array of E.164 prefixes ('+86170'); an empty
 * array blocks nothing. null when the value has another shape (the caller keeps the 08 default).
 */
export function parseBlockedPrefixes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const prefixes: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const prefix: unknown = value[index];
    if (typeof prefix !== 'string' || !PREFIX.test(prefix)) return null;
    prefixes.push(prefix);
  }
  return Object.freeze(prefixes);
}

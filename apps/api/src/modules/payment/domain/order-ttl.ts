// B2-15b: pay time limit of a pay order (08 BR-PAY-03: pay.order_ttl_minutes, default 15; task
// §9.3 / §9.4). Pure: the raw config value comes in, the caller reads it (content's
// ContentReader.configValue) and alerts on a fallback.

/** Code default of `pay.order_ttl_minutes` (BR-PAY-03 细则); config_items of the same key overrides. */
export const DEFAULT_ORDER_TTL_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/** The TTL read from config_items `pay.order_ttl_minutes`. */
export interface OrderTtl {
  /** Minutes from creation to expire_at. */
  readonly minutes: number;
  /** True when a value was present but unusable, so the default was used (the caller alerts). */
  readonly fallback: boolean;
}

/**
 * The TTL from the raw config value: a positive safe integer is used as is; absent (null or
 * undefined) is the default 15 without fallback; any other value (0, negatives, fractions,
 * strings, booleans, objects) is the default 15 with fallback = true.
 */
export function orderTtlMinutes(raw: unknown): OrderTtl {
  if (raw === null || raw === undefined) {
    return { minutes: DEFAULT_ORDER_TTL_MINUTES, fallback: false };
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return { minutes: raw, fallback: false };
  }
  return { minutes: DEFAULT_ORDER_TTL_MINUTES, fallback: true };
}

/** expire_at = now + ttlMinutes, exact to the millisecond (no rounding, no calendar shift). */
export function payOrderExpireAt(now: Date, ttlMinutes: number): Date {
  // A copy moved by the TTL: the Clock's instant is never modified (no `new Date(` in app code).
  const expireAt = structuredClone(now);
  expireAt.setTime(now.getTime() + ttlMinutes * MS_PER_MINUTE);
  return expireAt;
}

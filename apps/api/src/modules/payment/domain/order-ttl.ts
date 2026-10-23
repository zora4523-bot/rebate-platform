// B2-15b: pay time limit of a pay order (08 BR-PAY-03: pay.order_ttl_minutes, default 15; task
// §9.3 / §9.4). NotImplemented skeleton (rule-test phase).

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
  void raw;
  throw new Error('NotImplemented: orderTtlMinutes');
}

/** expire_at = now + ttlMinutes, exact to the millisecond (no rounding, no calendar shift). */
export function payOrderExpireAt(now: Date, ttlMinutes: number): Date {
  void now;
  void ttlMinutes;
  throw new Error('NotImplemented: payOrderExpireAt');
}

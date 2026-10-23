// B2-15b: may a new pay order be placed (08 BR-PAY-01 ④; task §9.2 / §9.3)? Pure decision on the
// raw config values; reading them (content's ContentReader.configValue) is the caller's job.
import type { PayPlatform, PayUnavailableReason } from './types.ts';

/** The three native apps a business type can be sold on (BR-PAY-01). */
export const PAY_PLATFORMS: readonly PayPlatform[] = Object.freeze(['ios', 'android', 'harmony']);

/** The raw inputs of the check; a config key that does not exist is passed as null. */
export interface SaleCheckInput {
  /** Value of `pay.enabled`. */
  readonly payEnabled: unknown;
  /** Value of `pay.channel_enabled.<pay_channel>`. */
  readonly channelEnabled: unknown;
  /** The request's X-Platform. */
  readonly platform: string;
  /** Platforms the registry gives the business type; null when the type is not registered. */
  readonly registeredPlatforms: readonly PayPlatform[] | null;
  /**
   * Value of `pay.biz.<biz_type>.platforms`: an array of PayPlatform replaces the registered set;
   * null (absent) keeps it.
   */
  readonly platformsOverride: unknown;
}

/** A switch is on only when its value is exactly the JSON boolean true (default off). */
export function isSwitchOn(raw: unknown): boolean {
  return raw === true;
}

export function isPayPlatform(value: unknown): value is PayPlatform {
  return typeof value === 'string' && (PAY_PLATFORMS as readonly string[]).includes(value);
}

/** The parsed `pay.biz.<biz_type>.platforms` value. */
export interface PlatformsOverride {
  /** The platforms the config names (possibly empty: nothing sellable); null when absent. */
  readonly platforms: readonly PayPlatform[] | null;
  /**
   * True when a value was present but unusable (not an array, an unknown platform inside, an
   * object, a string, …): the caller keeps the registered platforms and alerts once (§12.5).
   */
  readonly fallback: boolean;
}

/**
 * Parses the raw `pay.biz.<biz_type>.platforms`: null / undefined → absent; an array whose every
 * element is a PayPlatform (an empty array included: nothing is sellable) → that set; anything
 * else → absent with fallback = true.
 */
export function platformsOverrideOf(raw: unknown): PlatformsOverride {
  if (raw === null || raw === undefined) return { platforms: null, fallback: false };
  if (Array.isArray(raw) && raw.every(isPayPlatform)) {
    return { platforms: [...new Set(raw as PayPlatform[])], fallback: false };
  }
  return { platforms: null, fallback: true };
}

/**
 * The platforms a registered business type is sold on: the config override when usable, else the
 * registered default. Unregistered (null) stays null.
 */
export function effectivePlatforms(
  registeredPlatforms: readonly PayPlatform[] | null,
  platformsOverride: unknown,
): readonly PayPlatform[] | null {
  if (registeredPlatforms === null) return null;
  const override = platformsOverrideOf(platformsOverride);
  return override.platforms ?? registeredPlatforms;
}

/**
 * The 30901 reason, or null when the order may be placed. Order: pay_disabled → channel_disabled
 * → (type not registered: biz_not_sellable) → platform outside the effective platforms:
 * platform_not_allowed.
 */
export function payUnavailableReason(input: SaleCheckInput): PayUnavailableReason | null {
  if (!isSwitchOn(input.payEnabled)) return 'pay_disabled';
  if (!isSwitchOn(input.channelEnabled)) return 'channel_disabled';
  const platforms = effectivePlatforms(input.registeredPlatforms, input.platformsOverride);
  if (platforms === null) return 'biz_not_sellable';
  if (!(platforms as readonly string[]).includes(input.platform)) return 'platform_not_allowed';
  return null;
}

// B2-15b: may a new pay order be placed (08 BR-PAY-01 ④; task §9.2 / §9.3)? Pure decision on the
// raw config values; reading them (content's ContentReader.configValue) is the caller's job.
// NotImplemented skeleton (rule-test phase).
import type { PayPlatform, PayUnavailableReason } from './types.ts';

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
  void raw;
  throw new Error('NotImplemented: isSwitchOn');
}

/**
 * The 30901 reason, or null when the order may be placed. Order: pay_disabled → channel_disabled
 * → (type not registered: biz_not_sellable) → platform outside the effective platforms:
 * platform_not_allowed.
 */
export function payUnavailableReason(input: SaleCheckInput): PayUnavailableReason | null {
  void input;
  throw new Error('NotImplemented: payUnavailableReason');
}

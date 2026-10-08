// Lifetimes in seconds read from the business configuration of one app (content's reader, the
// SmsConfigReader port): auth.oauth_attempt_ttl_sec, auth.step_up_ttl_sec, auth.h5_token_ttl_sec
// (B1-02f). A missing key, or a value that is not a whole number of seconds within the bound, keeps
// the rule's default (BR-ID-04 细则 600 s, BR-ID-08 300 s, BR-ID-32 900 s).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { SmsConfigReader } from './sms-codes.ts';

/** Longest configurable lifetime of these short-lived credentials: one day. */
export const MAX_CONFIGURED_SECONDS = 86_400;

/** The configured lifetime of `key` for `appId`, or `fallback`. */
export async function configuredSeconds(
  config: SmsConfigReader,
  appId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const entry = await config.configValue(appId, key);
  const value = entry?.value;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CONFIGURED_SECONDS
    ? value
    : fallback;
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
export function instantPlus(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

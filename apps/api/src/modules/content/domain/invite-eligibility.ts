// F1-02zze: invite.eligibility_days of GET /v1/config (08 BR-INV-18 细则 / BR-INV-24 细则;
// 04 §10.1; contract ConfigInvite.eligibility_days). Read from the business key
// growth.invite_reward.eligibility_days in the same batch as every other config key; never from the
// same-named invite.eligibility_days nor from invite_rewards' locked values.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { ConfigReport, ConfigValues } from './config-values.ts';
import { configItemSpecOf } from './config-registry.ts';

export const INVITE_ELIGIBILITY_DAYS_KEY = 'growth.invite_reward.eligibility_days';
/** 08 11_INV BR-INV-24 细则 l.560: the eligibility period when the key is absent or malformed. */
export const INVITE_ELIGIBILITY_DEFAULT_DAYS = 30;

/**
 * F1-02zze: derive the always-delivered invitation eligibility days.
 * A safe integer within the registry's write bounds (config-registry, F1-02zx) is delivered as is;
 * an absent key gives the default silently; any other value gives the default and is reported
 * through report.invalid (never report.missing, never clamped).
 */
export function deriveInviteEligibilityDays(values: ConfigValues, report: ConfigReport): number {
  if (!values.has(INVITE_ELIGIBILITY_DAYS_KEY)) return INVITE_ELIGIBILITY_DEFAULT_DAYS;
  const value = values.get(INVITE_ELIGIBILITY_DAYS_KEY);
  const range = configItemSpecOf(INVITE_ELIGIBILITY_DAYS_KEY)?.range;
  if (
    range !== undefined &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= range.min &&
    value <= range.max
  ) {
    return value;
  }
  report.invalid(INVITE_ELIGIBILITY_DAYS_KEY);
  return INVITE_ELIGIBILITY_DEFAULT_DAYS;
}

import type { ConfigReport, ConfigValues } from './client-config.ts';

/**
 * F1-02zze: derive the always-delivered invitation eligibility days.
 * Implementation must use configItemSpecOf('growth.invite_reward.eligibility_days').range
 * for the bounds and a named default of 30 (08 BR-INV-24, l.560).
 */
export function deriveInviteEligibilityDays(values: ConfigValues, report: ConfigReport): number {
  void values;
  void report;
  throw new Error('NotImplemented: deriveInviteEligibilityDays');
}

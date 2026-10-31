// Admin appeal console writes (CT-24r; 规划/08 BR-ID-36, BR-ID-31; 04 §6.6 appeals, §11.2
// risk.appeal; task B1-03ze): POST /admin/v1/appeals/{appeal_id}/claim (adminClaimAppeal), POST
// /admin/v1/appeals/{appeal_id}/resolve (adminResolveAppeal) and POST /admin/v1/appeals
// (adminRegisterAppeal).
//
// Test-stage skeleton: only the two pure rules the rule tests call by path. The implementation
// adds the claim / resolve / register service, the controller and the module wiring.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';

/** What resolving an appeal needs to know (CT-24r adminResolveAppeal; 编排裁定 D10-154). */
export interface AppealResolveRequirementInput {
  readonly decision: Schema<'AdminAppealDecision'>;
  readonly target_type: Schema<'AdminAppealTargetType'>;
  /** appeals.prev_risk_state: banned / frozen for an account appeal, else null. */
  readonly prev_risk_state: Schema<'AdminAppealPrevRiskState'> | null;
  /** The blocked request's cause for a blocked_request appeal, else null. */
  readonly cause: Schema<'AdminBlockedRequestCause'> | null;
}

/** What a resolution needs on top of risk.appeal. */
export interface AppealResolveRequirement {
  /** The extra permission point; null when risk.appeal alone is enough. */
  readonly permission: Schema<'AdminAppealRevokePermission'> | null;
  /** The step-up tier; null when no step-up is needed. */
  readonly step_up: 'totp' | null;
}

/**
 * The extra permission point and step-up tier of a resolution: revoking an account appeal against
 * a ban needs risk.ban, against a freeze risk.freeze, and revoking a blocked_request appeal with
 * cause blocklist risk.blocklist, each with a totp step-up; anything else needs neither.
 */
export function appealResolveRequirement(
  input: AppealResolveRequirementInput,
): AppealResolveRequirement {
  void input;
  throw new Error('NotImplemented: appealResolveRequirement');
}

/**
 * The resolve note / registration reason as stored in the audit record: the value trimmed of
 * surrounding whitespace when it is a string of 1–200 characters after trimming, else null (the
 * caller answers 20001 naming the field).
 */
export function appealConsoleText(value: unknown): string | null {
  void value;
  throw new Error('NotImplemented: appealConsoleText');
}

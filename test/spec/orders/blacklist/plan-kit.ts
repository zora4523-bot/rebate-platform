// Shared constants of the B1-09b rule tests (08 BR-ATTR-26 examples), written out by hand.
// Nothing here imports the test-database base: only *.int.test.ts may.

/** BR-FUND-01 rebate_status, all six. */
export const REBATE_STATES = [
  'UNATTRIBUTED',
  'ESTIMATED',
  'WAITING',
  'CREDITED',
  'VOID',
  'CLAWED_BACK',
] as const;

/** R6 sources (BR-ATTR-26「rebate_status ∈ {UNATTRIBUTED, ESTIMATED, WAITING}」). */
export const PRECREDIT = ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'] as const;

/** BR-ATTR-26 例（渠道单）：relation_id=R8. */
export const CHANNEL = 'R8';
/** BR-ATTR-26 例：名单 value=123456. */
export const SUFFIX = '123456';
/** BR-ATTR-26 例：父单号末 6 位 123456 → 命中. */
export const PARENT_HIT = '3301987654123456';
/** BR-ATTR-26 例：父单号 3301987654012345 → 不命中. */
export const PARENT_MISS = '3301987654012345';

/** 02 §11 alert of a credited order hitting the blacklist (D10-48). */
export const AFTER_CREDIT = 'order.blacklist_hit_after_credit';

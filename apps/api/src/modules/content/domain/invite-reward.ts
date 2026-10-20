// Task F1-02zn (BR-INV-24 细则, orchestrator rulings D-C3 and D10-94 ⑨): the save-time guard of
// the invite reward campaign, as pure functions. While growth.invite_reward.enabled is on, the
// per-side amount and both budgets must each be a positive integer of fen; turning the switch on
// requires that, and while it is on none of them may be saved as 0. The minimum paid amount and
// the IP window take no part. The application layer runs the check inside the write transaction
// after taking the campaign's lock, so the two write paths cannot both succeed.

export const INVITE_REWARD_ENABLED = 'growth.invite_reward.enabled';
export const INVITE_REWARD_AMOUNT = 'growth.invite_reward.amount_fen';
export const INVITE_REWARD_DAILY_BUDGET = 'growth.invite_reward.daily_budget_fen';
export const INVITE_REWARD_TOTAL_BUDGET = 'growth.invite_reward.total_budget_fen';

/** Configuration items that must be positive while the campaign switch is on. */
export const INVITE_REWARD_POSITIVE_KEYS: readonly string[] = Object.freeze([
  INVITE_REWARD_AMOUNT,
  INVITE_REWARD_DAILY_BUDGET,
  INVITE_REWARD_TOTAL_BUDGET,
]);

const POSITIVE = new Set(INVITE_REWARD_POSITIVE_KEYS);

/** Whether writing `key` may conflict with the campaign switch (and so takes its lock). */
export function inviteRewardGuardedKey(key: string): boolean {
  return POSITIVE.has(key);
}

/** A stored or requested value counts as set only when it is an integer of at least 1 fen. */
export function inviteRewardPositive(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Whether a switch write is turning the campaign on (only that direction is checked). */
export function inviteRewardTurnsOn(key: string, value: unknown): boolean {
  return key === INVITE_REWARD_ENABLED && value === true;
}

/** Whether the stored switch value means on; a missing row or any other value is off. */
export function inviteRewardEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Whether turning the switch on must be refused, given the current values by key (a missing key
 * is a missing row and counts as 0).
 */
export function inviteRewardOpenRefused(current: ReadonlyMap<string, unknown>): boolean {
  return INVITE_REWARD_POSITIVE_KEYS.some((key) => !inviteRewardPositive(current.get(key)));
}

/** The guarded keys among `entries` whose new value is not positive, in the given order. */
export function inviteRewardZeroedKeys(
  entries: readonly { readonly key: string; readonly value: unknown }[],
): string[] {
  return entries
    .filter((entry) => inviteRewardGuardedKey(entry.key) && !inviteRewardPositive(entry.value))
    .map((entry) => entry.key);
}

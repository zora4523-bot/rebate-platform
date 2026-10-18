// B1-08m: the pending-track cards of one user (BR-ATTR-21 ①～③, 细则「待跟单卡按实际外跳选」
// 「待跟单卡的完成与关闭按尝试」). Pure: the caller hands in the user's own open attempts of the
// last 72 hours (linking's PendingAttemptStore) and the user's own orders on those links; every
// decision is made here, at the server's `now`.
// - Candidates: attempts whose open log is not a share-link open (pid_scene ≠ share) and whose
//   open is at most 72 hours old (exactly 72 hours still counts; durations in milliseconds).
// - Per platform two tiers: attempts with a jump report first, the rest only when there is none.
//   In the tier used the latest open wins; the same open time → the greatest attempt_id string.
// - The selected attempt completed (an order on its link with source_match set and ≠ none whose
//   attr_at is not earlier than the open minus the completion tolerance) → no card for the
//   platform, and no fallback to any other attempt. Dismissed → the card is still returned with
//   dismissed=true (04 §6.4, the client hides it), again without falling back.
// - show_claim_entry: at least 30 minutes since the open; a no-rebate open only when its reason is
//   auth_declined / auth_failed and the platform was authorized after it (TRADE-09).
import type { Schema } from '@couli/contracts-ts';
import type { PendingAttempt } from '../../linking/index.ts';

export interface PendingTrackOrder {
  link_id: string | null;
  attr_at: Date;
  source_match: string | null;
}

export interface SelectPendingTracksInput {
  now: Date;
  toleranceSec: number;
  attempts: readonly PendingAttempt[];
  orders: readonly PendingTrackOrder[];
}

/** BR-ATTR-21 ③: a card lives 72 hours from its open (inclusive). */
export const PENDING_TRACK_LIFETIME_MS = 72 * 3600_000;
/** BR-ATTR-21: the claim entry shows from 30 minutes after the open (inclusive). */
export const PENDING_TRACK_CLAIM_AFTER_MS = 30 * 60_000;
const CLAIMABLE_NO_REBATE_REASONS: ReadonlySet<string> = new Set(['auth_declined', 'auth_failed']);

/** Later open first; the same open time → the greater attempt_id (lowercase UUIDv7). */
function later(a: PendingAttempt, b: PendingAttempt): boolean {
  const diff = a.opened_at.getTime() - b.opened_at.getTime();
  if (diff !== 0) return diff > 0;
  return a.attempt_id > b.attempt_id;
}

function latest(attempts: readonly PendingAttempt[]): PendingAttempt | undefined {
  let best: PendingAttempt | undefined;
  for (const candidate of attempts) {
    if (best === undefined || later(candidate, best)) best = candidate;
  }
  return best;
}

/** BR-ATTR-21 细则「完成」: an order of this user on the attempt's link, paid no earlier than it. */
function completes(
  order: PendingTrackOrder,
  attempt: PendingAttempt,
  toleranceMs: number,
): boolean {
  return (
    order.link_id === attempt.link_id &&
    order.source_match !== null &&
    order.source_match !== 'none' &&
    order.attr_at.getTime() >= attempt.opened_at.getTime() - toleranceMs
  );
}

function claimable(attempt: PendingAttempt, elapsedMs: number): boolean {
  if (elapsedMs < PENDING_TRACK_CLAIM_AFTER_MS) return false;
  if (!attempt.no_rebate) return true;
  return (
    attempt.no_rebate_reason !== null &&
    CLAIMABLE_NO_REBATE_REASONS.has(attempt.no_rebate_reason) &&
    attempt.authorized_after
  );
}

export function selectPendingTracks(input: SelectPendingTracksInput): Schema<'PendingTrack'>[] {
  const nowMs = input.now.getTime();
  const toleranceMs = input.toleranceSec * 1000;
  const byPlatform = new Map<string, { reported: PendingAttempt[]; other: PendingAttempt[] }>();
  for (const attempt of input.attempts) {
    if (attempt.pid_scene === 'share') continue;
    if (nowMs - attempt.opened_at.getTime() > PENDING_TRACK_LIFETIME_MS) continue;
    let tiers = byPlatform.get(attempt.platform);
    if (tiers === undefined) {
      tiers = { reported: [], other: [] };
      byPlatform.set(attempt.platform, tiers);
    }
    (attempt.jump_reported_at === null ? tiers.other : tiers.reported).push(attempt);
  }
  const items: Schema<'PendingTrack'>[] = [];
  for (const tiers of byPlatform.values()) {
    const selected = latest(tiers.reported.length > 0 ? tiers.reported : tiers.other);
    if (selected === undefined) continue;
    if (input.orders.some((order) => completes(order, selected, toleranceMs))) continue;
    items.push({
      link_id: selected.link_id,
      attempt_id: selected.attempt_id,
      platform: selected.platform,
      jumped_at: selected.opened_at.toISOString(),
      show_claim_entry: claimable(selected, nowMs - selected.opened_at.getTime()),
      dismissed: selected.dismissed_at !== null,
    });
  }
  return items.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
}

// B1-10h (J-6): whether the order page pins its "未跟单？去找回" entry (08 BR-ATTR-17; AC-S1-25 ②).
// Pure: no clock, no database. Every instant is compared as absolute milliseconds.
// 1. A jump-out is a link_log of this app whose actor COALESCE(opener_user_id, user_id) is the
//    user, event convert | open, result_code 0, pid_scene not 'share' (null counts as not share),
//    created_at ≤ now. A no-rebate one (BR-ID-18) counts only when its reason is auth_declined or
//    auth_failed and the user has authorised that platform since (拍板第二批 TRADE-09): the same
//    test as the pending-track card — the binding of that platform is active and bound_at ≥ the
//    log's created_at (Taobao also needs a usable relation_id; Pinduoduo's active row is the
//    filing; any other platform never). A record that does not count is as if absent, so it never
//    hides an earlier one that does.
// 2. J = the counting jump-out with the latest created_at, across platforms. None → false; only J
//    is looked at, never an earlier one.
// 3. now − J in [30 minutes, 72 hours], both ends inclusive, else false.
// 4. Any order of this app owned by the user with attr_at ≥ J (any platform, buy_type, status)
//    → false. Otherwise true.
import type {
  ClaimEntryBinding,
  ClaimEntryFacts,
  ClaimEntryLog,
  ClaimEntryScope,
} from '../../linking/index.ts';

export interface ClaimEntryInput extends ClaimEntryFacts, ClaimEntryScope {
  readonly now: Date;
  /** Latest attr_at among this App's orders owned by this user, without list filters. */
  readonly latest_order_attr_at: Date | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** BR-ATTR-17: pinned once the latest jump-out is at least 30 minutes old … */
export const CLAIM_ENTRY_PIN_FROM_MS = 30 * MINUTE_MS;
/** … and while it is at most 72 hours old; an older latest jump-out is never pinned. */
export const CLAIM_ENTRY_PIN_UNTIL_MS = 72 * HOUR_MS;

const JUMP_EVENTS: ReadonlySet<string> = new Set(['convert', 'open']);
/** 拍板第二批 TRADE-09: the no-rebate reasons that count once the platform is authorised. */
const AUTH_REASONS: ReadonlySet<string> = new Set(['auth_declined', 'auth_failed']);
/** contracts BaichuanTaoke.relation_id bound (as linking's pending-attempts RELATION_MAX). */
const RELATION_MAX = 32;

function usableRelation(relationId: string | null): boolean {
  return relationId !== null && relationId !== '' && relationId.length <= RELATION_MAX;
}

/** The user's binding of the log's platform is active and was bound at or after the log. */
function authorisedSince(
  log: ClaimEntryLog,
  bindings: readonly ClaimEntryBinding[],
  scope: ClaimEntryScope,
): boolean {
  if (log.platform !== 'taobao' && log.platform !== 'pdd') return false;
  const at = log.created_at.getTime();
  return bindings.some(
    (binding) =>
      binding.app_id === scope.app_id &&
      binding.user_id === scope.user_id &&
      binding.platform === log.platform &&
      binding.status === 'active' &&
      binding.bound_at !== null &&
      binding.bound_at.getTime() >= at &&
      (binding.platform === 'pdd' || usableRelation(binding.relation_id)),
  );
}

function countsAsJump(log: ClaimEntryLog, input: ClaimEntryInput, now: number): boolean {
  if (log.app_id !== input.app_id) return false;
  if ((log.opener_user_id ?? log.user_id) !== input.user_id) return false;
  if (!JUMP_EVENTS.has(log.event) || log.result_code !== 0) return false;
  if (log.pid_scene === 'share') return false;
  if (log.created_at.getTime() > now) return false;
  if (!log.no_rebate) return true;
  return (
    log.no_rebate_reason !== null &&
    AUTH_REASONS.has(log.no_rebate_reason) &&
    authorisedSince(log, input.bindings, input)
  );
}

/** BR-ATTR-17 / AC-S1-25②: latest eligible jump, then [30 minutes,72 hours], then any order. */
export function claimEntryPinned(input: ClaimEntryInput): boolean {
  const now = input.now.getTime();
  let latest: number | null = null;
  for (const log of input.logs) {
    if (!countsAsJump(log, input, now)) continue;
    const at = log.created_at.getTime();
    if (latest === null || at > latest) latest = at;
  }
  if (latest === null) return false;
  const age = now - latest;
  if (age < CLAIM_ENTRY_PIN_FROM_MS || age > CLAIM_ENTRY_PIN_UNTIL_MS) return false;
  const orderAt = input.latest_order_attr_at;
  return orderAt === null || orderAt.getTime() < latest;
}

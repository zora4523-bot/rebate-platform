// B1-10c: the evidence of one claim item (08 BR-ATTR-18, BR-ID-18; BR-ATTR-13 ③ W_backfill;
// orchestrator 口径 2～5). Pure: no database, clock or configuration read; the caller passes the
// applicant's raw link_logs, union_bindings and union_binding_conflicts rows (linking's reader)
// and the order's product key (orders.product_key, or derived by the caller when that is empty).
//
// A link_log counts when it is the applicant's own (user_id; opener_user_id alone never counts,
// 待裁定 3), in the claim's app and platform, event ∈ {convert, open}, result_code = 0 and
// created_at ∈ [attr_at − W hours, attr_at] (both ends, absolute milliseconds). pid_scene,
// cache_hit and expired are not looked at. A no_rebate row counts only when its reason is
// auth_declined / auth_failed, the platform is taobao or pdd (待裁定 6), the applicant has an
// active binding there now and none is blocked (待裁定 5), and no 30151 conflict of the applicant
// on that platform is unresolved at attr_at (occurred_at ≤ attr_at and resolved_at null or later);
// otherwise the row is treated as absent.
// Level: strong when the order's product key is non-empty and a counted row has the same key;
// otherwise weak when anything counted; otherwise none. References (待裁定 4): strong → the
// counted rows of the same key; weak → the counted rows of the order's shop when there are any,
// else every counted row; none → empty. Newest first (created_at, then id), at most 20.
import type {
  ClaimEvidenceLog,
  ClaimEvidenceBinding,
  ClaimEvidenceConflict,
} from '../../linking/index.ts';
import { instantAt } from './sync-window.ts';

export type ClaimEvidenceLevel = 'strong' | 'weak' | 'none';
export interface ClaimEvidenceInput {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string;
  readonly attrAt: Date;
  /** Already resolved from the order column or the product-key port. */
  readonly productKey: string | null;
  readonly shopId: string | null;
  readonly windowHours: number;
  readonly logs: readonly ClaimEvidenceLog[];
  readonly bindings: readonly ClaimEvidenceBinding[];
  readonly conflicts: readonly ClaimEvidenceConflict[];
}
export interface ClaimItemEvidence {
  readonly evidence: ClaimEvidenceLevel;
  readonly evidence_link_log_ids: readonly bigint[];
}

/** attr.backfill_window_hours default (BR-ATTR-13 ③). */
export const DEFAULT_BACKFILL_WINDOW_HOURS = 360;
/** Most link_log references kept per item (待裁定 4). */
export const MAX_EVIDENCE_REFERENCES = 20;
const HOUR_MS = 3_600_000;
const EVENTS: ReadonlySet<string> = new Set(['convert', 'open']);
/** BR-ID-18: only the authorisation reasons may ever be recovered. */
const AUTH_REASONS: ReadonlySet<string> = new Set(['auth_declined', 'auth_failed']);
/** Platforms whose authorisation 08 defines (taobao binding active, pdd filing active). */
const AUTH_PLATFORMS: ReadonlySet<string> = new Set(['taobao', 'pdd']);

/** W_backfill in hours: a positive safe integer, otherwise the default. */
export function backfillWindowHours(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BACKFILL_WINDOW_HOURS;
}

/** The first instant of W_backfill for `attrAt` (never before the Unix epoch). */
export function backfillWindowStart(attrAt: Date, windowHours: number): Date {
  return instantAt(
    attrAt,
    Math.max(attrAt.getTime() - backfillWindowHours(windowHours) * HOUR_MS, 0),
  );
}

function nonEmpty(value: string | null): value is string {
  return value !== null && value !== '';
}

/** Whether the applicant may use no_rebate rows of the authorisation reasons (BR-ID-18). */
function authorised(input: ClaimEvidenceInput): boolean {
  if (!AUTH_PLATFORMS.has(input.platform)) return false;
  if (!input.bindings.some((row) => row.status === 'active')) return false;
  if (input.bindings.some((row) => row.status === 'blocked')) return false;
  const attr = input.attrAt.getTime();
  return !input.conflicts.some(
    (row) =>
      row.occurred_at.getTime() <= attr &&
      (row.resolved_at === null || row.resolved_at.getTime() > attr),
  );
}

function newestFirst(a: ClaimEvidenceLog, b: ClaimEvidenceLog): number {
  const byTime = b.created_at.getTime() - a.created_at.getTime();
  if (byTime !== 0) return byTime;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

function references(rows: readonly ClaimEvidenceLog[]): bigint[] {
  return [...rows]
    .sort(newestFirst)
    .slice(0, MAX_EVIDENCE_REFERENCES)
    .map((row) => row.id);
}

export function judgeClaimEvidence(input: ClaimEvidenceInput): ClaimItemEvidence {
  const attr = input.attrAt.getTime();
  const from = attr - backfillWindowHours(input.windowHours) * HOUR_MS;
  let noRebateAllowed: boolean | undefined;
  const counted = input.logs.filter((row) => {
    if (row.app_id !== input.appId || row.user_id !== input.userId) return false;
    if (row.platform !== input.platform) return false;
    if (!EVENTS.has(row.event) || row.result_code !== 0) return false;
    const created = row.created_at.getTime();
    if (!(created >= from && created <= attr)) return false;
    if (!row.no_rebate) return true;
    if (row.no_rebate_reason === null || !AUTH_REASONS.has(row.no_rebate_reason)) return false;
    noRebateAllowed ??= authorised(input);
    return noRebateAllowed;
  });
  const { productKey, shopId } = input;
  if (nonEmpty(productKey)) {
    const same = counted.filter((row) => row.product_key === productKey);
    if (same.length > 0) return { evidence: 'strong', evidence_link_log_ids: references(same) };
  }
  if (counted.length === 0) return { evidence: 'none', evidence_link_log_ids: [] };
  const sameShop = nonEmpty(shopId) ? counted.filter((row) => row.shop_id === shopId) : [];
  return {
    evidence: 'weak',
    evidence_link_log_ids: references(sameShop.length > 0 ? sameShop : counted),
  };
}

/** The claim's level: the weakest of its items (none < weak < strong). */
export function weakestEvidence(levels: readonly ClaimEvidenceLevel[]): ClaimEvidenceLevel {
  if (levels.includes('none')) return 'none';
  if (levels.includes('weak')) return 'weak';
  return 'strong';
}

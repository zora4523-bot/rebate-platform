// Claim review helpers: contract types, the list query (URL search <-> request parameters),
// Beijing-time display, enum names and the outcome of a review write. No copy lives here
// (texts/claims.ts); attribution is never decided here, only the server's answer is read.
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { claimsTexts as t } from '../../texts/claims.ts';

export type ClaimRow = Schema<'AdminClaimListItem'>;
export type ClaimPage = Schema<'AdminClaimPage'>;
export type ClaimDetail = Schema<'AdminClaimDetail'>;
export type ClaimItem = Schema<'AdminClaimItem'>;
export type ClaimStatus = Schema<'ClaimStatus'>;
export type EvidenceLevel = Schema<'AdminClaimEvidenceLevel'>;
export type PlatformCode = Schema<'PlatformCode'>;
export type StaffRejectReason = Schema<'AdminClaimStaffRejectReason'>;

export const CLAIMS_URL = '/admin/v1/claims';
export const claimUrl = (claimId: string): string => `${CLAIMS_URL}/${encodeURIComponent(claimId)}`;
export const itemActionUrl = (
  claimId: string,
  itemId: string,
  action: 'approve' | 'reject',
): string => `${claimUrl(claimId)}/items/${encodeURIComponent(itemId)}/${action}`;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;
/** Review note: at least 5 characters after trimming (AdminClaimReviewReason, BR-ATTR-20). */
export const NOTE_MIN = 5;
/** q: 1–64 characters (adminListClaims). */
export const QUERY_MAX = 64;

/** Contract enum order (ClaimStatus): one tab each. */
export const STATUSES: readonly ClaimStatus[] = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
];
export const PLATFORMS: readonly PlatformCode[] = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['strong', 'weak', 'none'];
/** The six reasons a reviewer may choose (AdminClaimStaffRejectReason); never the system two. */
export const STAFF_REJECT_REASONS: readonly StaffRejectReason[] = [
  'NO_EVIDENCE',
  'EXPIRED_CLICK',
  'NOT_TRACKED',
  'OTHER_TLJ',
  'FRAUD',
  'OTHER',
];

/** Applied list conditions (what the last 【查询】 or tab sent). */
export interface ClaimQuery {
  readonly page: number;
  readonly status?: ClaimStatus | undefined;
  readonly platform?: PlatformCode | undefined;
  readonly evidence?: EvidenceLevel | undefined;
  readonly q?: string | undefined;
  readonly userId?: string | undefined;
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return values.find((candidate) => candidate === value);
}

function text(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/** Reads the list conditions of an address (`?status=` deep links, 【返回】 from a claim). */
export function queryFromSearch(search: string): ClaimQuery {
  const params = new URLSearchParams(search);
  const page = Number(params.get('page'));
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    status: oneOf(STATUSES, params.get('status')),
    platform: oneOf(PLATFORMS, params.get('platform')),
    evidence: oneOf(EVIDENCE_LEVELS, params.get('evidence_level')),
    q: text(params.get('q')),
    userId: text(params.get('user_id')),
  };
}

/** Request parameters of adminListClaims (absent conditions are left out). */
export function requestQuery(query: ClaimQuery): Record<string, string | number> {
  return {
    page: query.page,
    page_size: PAGE_SIZE,
    ...(query.platform === undefined ? {} : { platform: query.platform }),
    ...(query.evidence === undefined ? {} : { evidence_level: query.evidence }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.userId === undefined ? {} : { user_id: query.userId }),
    ...(query.q === undefined ? {} : { q: query.q }),
  };
}

/** The same conditions as an address search (`?…`, empty without conditions). */
export function searchOf(query: ClaimQuery): string {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.platform !== undefined) params.set('platform', query.platform);
  if (query.evidence !== undefined) params.set('evidence_level', query.evidence);
  if (query.q !== undefined) params.set('q', query.q);
  if (query.userId !== undefined) params.set('user_id', query.userId);
  if (query.page !== 1) params.set('page', String(query.page));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; null shows the dash, unreadable input is shown as is. */
export function beijingTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

const label = (names: Readonly<Record<string, string>>, code: string): string =>
  names[code] ?? code;
export const platformLabel = (code: string): string => label(t.platforms, code);
export const evidenceLabel = (code: string): string => label(t.evidence, code);
export const statusLabel = (code: string): string => label(t.status, code);
export const rejectReasonLabel = (code: string): string => label(t.rejectReasons, code);
export const sceneLabel = (code: string): string => label(t.scenes, code);
export const matchFieldLabel = (code: string): string => label(t.matchFields, code);

/** antd preset Tag / Badge status by claim status or item decision (the text carries the meaning). */
export function statusTone(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'approved') return 'success';
  if (status === 'auto_matched' || status === 'manual_review' || status === 'submitted')
    return 'warning';
  if (status === 'rejected') return 'error';
  return 'default';
}

export function evidenceTone(level: string): 'success' | 'warning' | 'error' | 'default' {
  if (level === 'strong') return 'success';
  if (level === 'weak') return 'warning';
  if (level === 'none') return 'error';
  return 'default';
}

/** A claim still awaiting a reviewer: the row action reads 【审核】, otherwise 【查看】. */
export function awaitsReview(status: string): boolean {
  return status === 'submitted' || status === 'auto_matched' || status === 'manual_review';
}

/** The trimmed note when it is long enough to send, else undefined. */
export function validNote(note: string): string | undefined {
  const trimmed = note.trim();
  return Array.from(trimmed).length >= NOTE_MIN ? trimmed : undefined;
}

/**
 * What the returned claim says about the item just reviewed: closed by the system because the
 * order was attributed before the review (cancelled for the applicant, rejected NOT_IN_POOL
 * otherwise; decided_by null), rejected by the system as ORDER_INVALID, or a reviewer's decision.
 */
export type ReviewOutcome = 'auto_attributed' | 'order_invalid' | 'reviewed';

export function outcomeOf(item: ClaimItem | undefined): ReviewOutcome {
  if (item === undefined || item.decided_by !== null || item.decision === null) return 'reviewed';
  if (item.decision === 'cancelled') return 'auto_attributed';
  if (item.decision === 'rejected' && item.reject_reason === 'NOT_IN_POOL')
    return 'auto_attributed';
  if (item.decision === 'rejected' && item.reject_reason === 'ORDER_INVALID')
    return 'order_invalid';
  return 'reviewed';
}

export type FailureKind = 'forbidden' | 'invalid' | 'conflict' | 'failed';

/** 10403 no permission, 20001 parameters, 20902 claim_item changed meanwhile, else failed. */
export function failureOf(cause: unknown): FailureKind {
  if (!(cause instanceof AdminApiError)) return 'failed';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001) return 'invalid';
  if (cause.code === 20902) return 'conflict';
  return 'failed';
}

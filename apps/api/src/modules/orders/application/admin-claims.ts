// B1-10j: the console's claim review reads (GET /admin/v1/claims, GET /admin/v1/claims/{claim_id};
// BR-ATTR-30, BR-ATTR-18, BR-ID-33; contract adminListClaims / adminGetClaim). The permission check
// (order.claim, or user.lookup together with user_id) is the controller's, through platform's
// AdminOperationGuard; appId is always the guard's actor, never a header or query field. Reads
// only: nothing is written or audited. Other modules' data come in as ports assembled by
// app.module: identity's masked phones (decrypted and masked inside identity), admin's reviewer
// display names and linking's link_logs time and scene.
import { enums, type Schema } from '@couli/contracts-ts';
import {
  claimCounts,
  claimMatches,
  evidenceLinks,
  isUuid,
  normalizeClaimQuery,
  type EvidenceMoment,
} from '../domain/admin-claim-view.ts';
import type {
  AdminClaimFilter,
  AdminClaimReads,
  AdminClaimRow,
} from '../infra/admin-claim-reads.ts';

export interface AdminClaimListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly platform?: string;
  readonly evidence_level?: string;
  readonly status?: string;
  readonly user_id?: string;
  readonly q?: string;
}

/** Other modules' read ports (app.module). */
export interface AdminClaimPorts {
  /** identity: user_id → masked phone or null. */
  readonly phones: (
    appId: string,
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null>>;
  /** admin: admin_id → display name (display_name, else login_name); unknown ids left out. */
  readonly reviewerNames: (
    appId: string,
    adminIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** linking: link_logs id (decimal text) → time and scene; unknown ids left out. */
  readonly linkMoments: (
    appId: string,
    ids: readonly bigint[],
  ) => Promise<ReadonlyMap<string, EvidenceMoment>>;
}

export interface AdminClaimsDeps extends AdminClaimPorts {
  readonly reads: AdminClaimReads;
}

/**
 * A 20001 with data.fields (q or a non-UUID user_id on the list; claim_id for a non-UUID, unknown
 * or foreign claim).
 */
export class AdminClaimsFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super('orders: admin claim read refused');
    this.name = 'AdminClaimsFieldsError';
    this.fields = fields;
  }
}

const DEFAULT_PAGE_SIZE = 20;
const SCENES: ReadonlySet<string> = new Set(enums.scene);

type ListItem = Schema<'AdminClaimListItem'>;
type Detail = Schema<'AdminClaimDetail'>;

/** The shared reads; built without a database it fails closed on first use (50001). */
export class AdminClaims {
  readonly #deps: AdminClaimsDeps | null;

  constructor(deps: AdminClaimsDeps | null = null) {
    this.#deps = deps;
  }

  async list(appId: string, query: AdminClaimListQuery): Promise<Schema<'AdminClaimPage'>> {
    const refused: string[] = [];
    let q: string | undefined;
    if (query.q !== undefined) {
      const normalized = normalizeClaimQuery(query.q);
      if (normalized === null) refused.push('q');
      else q = normalized;
    }
    if (query.user_id !== undefined && !isUuid(query.user_id)) refused.push('user_id');
    if (refused.length > 0) throw new AdminClaimsFieldsError(refused);
    const deps = this.available();
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const filter: AdminClaimFilter = {
      appId,
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.evidence_level === undefined ? {} : { evidenceLevel: query.evidence_level }),
      ...(query.user_id === undefined ? {} : { userId: query.user_id }),
      ...(q === undefined ? {} : { q }),
    };
    const counts = claimCounts(await deps.reads.counts(filter));
    const total =
      query.status === undefined
        ? Object.values(counts).reduce((sum, n) => sum + n, 0)
        : (counts[query.status as keyof typeof counts] ?? 0);
    const offset = (page - 1) * pageSize;
    const rows =
      offset >= total ? [] : await deps.reads.page(filter, query.status, offset, pageSize);
    const phones = await deps.phones(
      appId,
      rows.map((row) => row.user_id),
    );
    return {
      items: rows.map((row) => listItem(row, phones)),
      page,
      page_size: pageSize,
      total,
      counts,
    };
  }

  /**
   * One claim of the app. With userId (any account) a claim of another applicant answers like an
   * unknown one: 20001 [claim_id].
   */
  async detail(appId: string, claimId: string, userId: string | undefined): Promise<Detail> {
    // A non-UUID claim_id names no claim: the same answer as an unknown one, before the database.
    if (!isUuid(claimId)) throw new AdminClaimsFieldsError(['claim_id']);
    const deps = this.available();
    const row = await deps.reads.claim(appId, claimId);
    if (row === undefined || (userId !== undefined && row.user_id !== userId)) {
      throw new AdminClaimsFieldsError(['claim_id']);
    }
    const items = await deps.reads.items(appId, claimId);
    const linkIds = items.flatMap((item) => item.evidence_link_log_ids ?? []);
    const reviewers = items.flatMap((item) => (item.decided_by === null ? [] : [item.decided_by]));
    const [phones, names, moments] = await Promise.all([
      deps.phones(appId, [row.user_id]),
      reviewers.length === 0
        ? Promise.resolve(new Map<string, string>())
        : deps.reviewerNames(appId, reviewers),
      linkIds.length === 0
        ? Promise.resolve(new Map<string, EvidenceMoment>())
        : deps.linkMoments(appId, linkIds),
    ]);
    const claim = {
      platform: row.platform,
      order_no: row.order_no,
      order_no_type: row.order_no_type,
      paid_date: row.paid_day,
    };
    return {
      ...listItem(row, phones),
      reason: row.reason,
      items: items.map((item) => ({
        item_id: item.id,
        sub_order_id: item.sub_order_id,
        evidence: item.evidence as Schema<'AdminClaimItem'>['evidence'],
        decision: item.decision as Schema<'AdminClaimItem'>['decision'],
        reject_reason: item.reject_reason as Schema<'AdminClaimItem'>['reject_reason'],
        decided_at: item.decided_at === null ? null : item.decided_at.toISOString(),
        decided_by: item.decided_by,
        decided_by_name: item.decided_by === null ? null : (names.get(item.decided_by) ?? null),
        row_version: item.row_version,
        matches: claimMatches(
          claim,
          item.order_sub_order_id === null
            ? null
            : {
                sub_order_id: item.order_sub_order_id,
                parent_order_id: item.parent_order_id,
                is_presale: item.is_presale === true,
                deposit_paid_at: item.deposit_paid_at,
                paid_at: item.paid_at,
              },
        ),
        evidence_links: evidenceLinks(
          item.evidence_link_log_ids,
          moments,
          SCENES,
        ) as Schema<'AdminClaimItem'>['evidence_links'],
      })),
    };
  }

  private available(): AdminClaimsDeps {
    if (this.#deps === null) throw new Error('orders: admin claim reads need the database');
    return this.#deps;
  }
}

function listItem(row: AdminClaimRow, phones: ReadonlyMap<string, string | null>): ListItem {
  return {
    claim_id: row.id,
    order_no: row.order_no,
    platform: row.platform as Schema<'PlatformCode'>,
    user: { user_id: row.user_id, phone_masked: phones.get(row.user_id) ?? null },
    paid_date: row.paid_day,
    submitted_at: row.created_at.toISOString(),
    evidence_level: row.evidence_level as ListItem['evidence_level'],
    status: row.status as Schema<'ClaimStatus'>,
  };
}

// Admin appeal console reads (CT-24r; 规划/08 BR-ID-36, BR-ID-33; 04 §6.6 appeals, §3.2 appeals and
// risk_hits, §11.2 risk.appeal; task B1-03zd): GET /admin/v1/appeals (adminListAppeals), GET
// /admin/v1/appeals/{appeal_id} (adminGetAppeal) and GET /admin/v1/blocked-requests
// (adminListBlockedRequests). Read only, scoped to the console's app_id; the only write is the
// audit record of a phone lookup that found something (contract).
//
// Test-stage skeleton: every body throws NotImplemented; the implementation stage fills it in.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto } from '../../platform/index.ts';

export type AdminAppealRevokePermission = Schema<'AdminAppealRevokePermission'>;
export type AdminBlockedRequestCause = Schema<'AdminBlockedRequestCause'>;
export type AdminBlocklistDimension = Schema<'AdminBlocklistDimension'>;

/** What revoke_permission depends on (CT-24r adminGetAppeal; 编排裁定 D10-154). */
export interface RevokePermissionInput {
  readonly target_type: Schema<'AdminAppealTargetType'>;
  /** appeals.prev_risk_state: banned / frozen for an account appeal, else null. */
  readonly prev_risk_state: Schema<'AdminAppealPrevRiskState'> | null;
  /** The blocked request's cause for a blocked_request appeal, else null. */
  readonly cause: AdminBlockedRequestCause | null;
}

/** The reason category of a blocked request (AdminBlockedRequest.cause / blocklist_dimension). */
export interface BlockedRequestCauseOf {
  readonly cause: AdminBlockedRequestCause;
  readonly blocklist_dimension: AdminBlocklistDimension | null;
}

/** List query as the route passed it (schema-checked; q not yet trimmed). */
export interface AdminAppealListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: Schema<'AppealStatus'>;
  readonly overdue?: boolean;
  readonly target_type?: Schema<'AdminAppealTargetType'>;
  readonly q?: string;
}

/** Blocked request lookup query as the route passed it (exactly one key checked by the service). */
export interface AdminBlockedRequestQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly phone?: string;
  readonly user_id?: string;
  readonly blocked_request_id?: string;
}

/** The console caller: app scope and the admin account (for the phone lookup's audit record). */
export interface AdminAppealsActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminAppealsReadOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
}

/**
 * The extra permission point revoking needs on top of risk.appeal: risk.ban for an account
 * appeal against a ban, risk.freeze against a freeze, risk.blocklist for a blocked_request appeal
 * whose request a blocklist entry blocked; null otherwise.
 */
export function appealRevokePermission(
  input: RevokePermissionInput,
): AdminAppealRevokePermission | null {
  void input;
  throw new Error('NotImplemented: appealRevokePermission');
}

/**
 * The cause of a blocked request from the rule codes of its risk_hits rows (blocklist.ts:
 * BLACKLIST_<DIMENSION> is a blocklist entry; SMS_BLOCKED_PREFIX, DEVICE_REGISTER_LIMIT and any
 * other rule are cause rule).
 */
export function blockedRequestCause(ruleIds: readonly string[]): BlockedRequestCauseOf {
  void ruleIds;
  throw new Error('NotImplemented: blockedRequestCause');
}

export class AdminAppealsRead {
  constructor(options: AdminAppealsReadOptions) {
    void options;
    throw new Error('NotImplemented: AdminAppealsRead');
  }

  list(
    actor: AdminAppealsActor,
    query: AdminAppealListQuery,
  ): Promise<Schema<'AdminAppealPage'>> {
    void actor;
    void query;
    throw new Error('NotImplemented: AdminAppealsRead.list');
  }

  get(actor: AdminAppealsActor, appealId: string): Promise<Schema<'AdminAppealDetail'>> {
    void actor;
    void appealId;
    throw new Error('NotImplemented: AdminAppealsRead.get');
  }

  blockedRequests(
    actor: AdminAppealsActor,
    query: AdminBlockedRequestQuery,
  ): Promise<Schema<'AdminBlockedRequestPage'>> {
    void actor;
    void query;
    throw new Error('NotImplemented: AdminAppealsRead.blockedRequests');
  }
}

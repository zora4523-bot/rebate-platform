// B1-10c (J-19): linking's raw reads for claim evidence (08 BR-ATTR-18, BR-ID-18) — the applicant's
// link_logs in a time range, and the applicant's union_bindings and union_binding_conflicts rows
// of one platform. Every query runs on the handle it is given (orders passes its acceptance
// transaction, so uncommitted rows of that transaction are seen and nothing is read twice on
// another connection), is scoped by app_id, user_id and platform, and names schema app. No
// evidence judgement, no write and no cache here: event, result_code, no_rebate and pid_scene are
// returned as stored; orders decides what counts.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface ClaimEvidenceScope {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string;
}
export interface ClaimEvidenceLog {
  readonly id: bigint;
  readonly app_id: string;
  readonly user_id: string | null;
  readonly opener_user_id: string | null;
  readonly platform: string | null;
  readonly event: string;
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly result_code: number;
  readonly no_rebate: boolean;
  readonly no_rebate_reason: string | null;
  readonly created_at: Date;
  readonly pid_scene: string | null;
  readonly cache_hit: boolean;
  readonly expired: boolean;
}
export interface ClaimEvidenceBinding {
  readonly status: string;
  readonly bound_at: Date | null;
  readonly released_at: Date | null;
}
export interface ClaimEvidenceConflict {
  readonly occurred_at: Date;
  readonly resolved_at: Date | null;
}
/** Raw reads on the supplied connection, scoped to the applicant. No evidence judgement here. */
export interface ClaimEvidenceReader {
  linkLogs(
    input: ClaimEvidenceScope & { readonly from: Date; readonly to: Date },
  ): Promise<readonly ClaimEvidenceLog[]>;
  bindings(input: ClaimEvidenceScope): Promise<readonly ClaimEvidenceBinding[]>;
  conflicts(input: ClaimEvidenceScope): Promise<readonly ClaimEvidenceConflict[]>;
}

const LOG_COLUMNS = [
  'id',
  'app_id',
  'user_id',
  'opener_user_id',
  'platform',
  'event',
  'product_key',
  'shop_id',
  'result_code',
  'no_rebate',
  'no_rebate_reason',
  'created_at',
  'pid_scene',
  'cache_hit',
  'expired',
] as const;

export function createClaimEvidenceReader(db: Kysely<DB> | Transaction<DB>): ClaimEvidenceReader {
  return {
    /** Rows created by the applicant (link_logs.user_id) with created_at in [from, to], both ends. */
    async linkLogs(input) {
      return db
        .withSchema('app')
        .selectFrom('link_logs')
        .select(LOG_COLUMNS)
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('platform', '=', input.platform)
        .where('created_at', '>=', input.from)
        .where('created_at', '<=', input.to)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
    },
    async bindings(input) {
      return db
        .withSchema('app')
        .selectFrom('union_bindings')
        .select(['status', 'bound_at', 'released_at'])
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('platform', '=', input.platform)
        .execute();
    },
    async conflicts(input) {
      return db
        .withSchema('app')
        .selectFrom('union_binding_conflicts')
        .select(['occurred_at', 'resolved_at'])
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('platform', '=', input.platform)
        .execute();
    },
  };
}

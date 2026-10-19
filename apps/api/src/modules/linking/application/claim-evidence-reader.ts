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
export function createClaimEvidenceReader(db: Kysely<DB> | Transaction<DB>): ClaimEvidenceReader {
  void db;
  throw new Error('NotImplemented: createClaimEvidenceReader');
}

import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface ClaimEntryScope {
  readonly app_id: string;
  readonly user_id: string;
}

export interface ClaimEntryLog {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly id: bigint;
  readonly opener_user_id: string | null;
  readonly platform: string | null;
  readonly event: string;
  readonly result_code: number;
  readonly pid_scene: string | null;
  readonly no_rebate: boolean;
  readonly no_rebate_reason: string | null;
  readonly created_at: Date;
}

export interface ClaimEntryBinding extends ClaimEntryScope {
  readonly platform: string;
  readonly status: string;
  readonly bound_at: Date | null;
  readonly relation_id: string | null;
}

export interface ClaimEntryFacts {
  readonly logs: readonly ClaimEntryLog[];
  readonly bindings: readonly ClaimEntryBinding[];
}

/** Raw linking facts across platforms; closed time range and COALESCE(opener_user_id,user_id).
 * Only app/actor/time/event/result filters may be pushed down; no pinning judgement here. */
export interface ClaimEntryReader {
  read(
    input: ClaimEntryScope & { readonly from: Date; readonly to: Date },
  ): Promise<ClaimEntryFacts>;
}

export function createClaimEntryReader(db: Kysely<DB>): ClaimEntryReader {
  void db;
  throw new Error('NotImplemented: createClaimEntryReader');
}

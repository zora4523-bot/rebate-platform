// growth change-log shapes (B1-11b; 04 §3.2 relation_change_logs / level_change_logs, migration
// 0041; BR-INV-11, BR-INV-14, BR-CALC-12). Types only in this skeleton: the input checks (a caller
// bug throws a TypeError before any SQL, same rules as the 0041 CHECK constraints) and the value
// sets are written by the implementation.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { UserLevel } from '@couli/contracts-ts';

export type { UserLevel } from '@couli/contracts-ts';

/** level_change_logs.source (MVP: register, admin). */
export type LevelChangeSource = 'register' | 'admin';

/** relation_change_logs.source (BR-INV-11). */
export type RelationChangeSource =
  'landing' | 'register' | 'backfill' | 'admin' | 'risk_same_device' | 'parent_deleted';

/**
 * One level change. register ⇒ from_level null; admin ⇒ from_level ≠ to_level and a non-blank
 * reason. operator is an opaque audit identity: `system`, `user:<user_id>` or `admin:<id>`.
 * effective_at is the caller's Clock instant; growth never takes the time itself.
 */
export interface LevelChangeInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly from_level: UserLevel | null;
  readonly to_level: UserLevel;
  readonly source: LevelChangeSource;
  readonly operator: string;
  readonly reason: string | null;
  readonly effective_at: Date;
}

/**
 * One relation change. from_parent_id ≠ to_parent_id; to_parent_id ≠ user_id; parent_deleted ⇒
 * to_parent_id null (null = no parent). at is the caller's Clock instant (the replay time).
 */
export interface RelationChangeInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly from_parent_id: string | null;
  readonly to_parent_id: string | null;
  readonly source: RelationChangeSource;
  readonly operator: string;
  readonly reason: string | null;
  readonly at: Date;
}

/** An as-of question: the state of one account of one app at instant `at`. */
export interface AsOfQuery {
  readonly app_id: string;
  readonly user_id: string;
  readonly at: Date;
}

/** levelAt answer: missing = no level log at or before `at` (L1 fallback, warned). */
export interface LevelAt {
  readonly level: UserLevel;
  readonly missing: boolean;
}

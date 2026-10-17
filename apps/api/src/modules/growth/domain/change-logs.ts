// growth change-log shapes (B1-11b; 04 §3.2 relation_change_logs / level_change_logs, migration
// 0041; BR-INV-11, BR-INV-14, BR-CALC-12). Caller bugs throw TypeError before any SQL.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { user_level, type UserLevel } from '@couli/contracts-ts';

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

const LEVELS: ReadonlySet<string> = new Set(user_level);
const LEVEL_SOURCES: ReadonlySet<string> = new Set(['register', 'admin']);
const RELATION_SOURCES: ReadonlySet<string> = new Set([
  'landing',
  'register',
  'backfill',
  'admin',
  'risk_same_device',
  'parent_deleted',
]);

export function isUserLevel(value: unknown): value is UserLevel {
  return typeof value === 'string' && LEVELS.has(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDate(value: unknown): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validateSubject(input: { app_id: string; user_id: string }): void {
  if (input == null || !nonBlank(input.app_id) || !nonBlank(input.user_id)) {
    throw new TypeError('growth: app_id and user_id must be non-blank strings');
  }
}

function validateAudit(input: { operator: string; reason: string | null }): void {
  if (!nonBlank(input.operator) || !(input.reason === null || typeof input.reason === 'string')) {
    throw new TypeError('growth: invalid operator or reason');
  }
}

export function validateLevelChange(input: LevelChangeInput): void {
  validateSubject(input);
  validateAudit(input);
  if (
    !isUserLevel(input.to_level) ||
    !(input.from_level === null || isUserLevel(input.from_level)) ||
    !LEVEL_SOURCES.has(input.source) ||
    !validDate(input.effective_at)
  ) {
    throw new TypeError('growth: invalid level, source or effective_at');
  }
  if (
    (input.source === 'register' && input.from_level !== null) ||
    (input.source === 'admin' &&
      (input.from_level === null || input.from_level === input.to_level || !nonBlank(input.reason)))
  ) {
    throw new TypeError('growth: invalid level change shape or admin reason');
  }
}

export function validateRelationChange(input: RelationChangeInput): void {
  validateSubject(input);
  validateAudit(input);
  if (
    !(input.from_parent_id === null || nonBlank(input.from_parent_id)) ||
    !(input.to_parent_id === null || nonBlank(input.to_parent_id)) ||
    !RELATION_SOURCES.has(input.source) ||
    !validDate(input.at)
  ) {
    throw new TypeError('growth: invalid parent, source or at');
  }
  // PostgreSQL UUID equality is case-insensitive; reject these caller bugs before SQL too.
  const from = input.from_parent_id?.toLowerCase() ?? null;
  const to = input.to_parent_id?.toLowerCase() ?? null;
  if (
    from === to ||
    to === input.user_id.toLowerCase() ||
    (input.source === 'parent_deleted' && to !== null)
  ) {
    throw new TypeError('growth: invalid relation change shape');
  }
}

export function validateAsOfQuery(query: AsOfQuery): void {
  validateSubject(query);
  if (!validDate(query.at)) throw new TypeError('growth: at must be a valid Date');
}

// growth change-log writers (B1-11b): insert one row into app.level_change_logs /
// app.relation_change_logs inside the caller's transaction (never opening or committing one),
// after the input checks; database errors propagate unchanged. users is never written here.
// Relation rows set created_at = at explicitly (B1-11t); level rows keep the DB default.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  validateLevelChange,
  validateRelationChange,
  type LevelChangeInput,
  type RelationChangeInput,
} from '../domain/change-logs.ts';
import type { GrowthLogTables } from './log-tables.ts';

export async function appendLevelChange(
  trx: Transaction<DB>,
  input: LevelChangeInput,
): Promise<void> {
  validateLevelChange(input);
  await trx
    .withTables<GrowthLogTables>()
    .withSchema('app')
    .insertInto('level_change_logs')
    .values({
      app_id: input.app_id,
      user_id: input.user_id,
      from_level: input.from_level,
      to_level: input.to_level,
      source: input.source,
      operator: input.operator,
      reason: input.reason,
      effective_at: input.effective_at,
    })
    .execute();
}

export async function appendRelationChange(
  trx: Transaction<DB>,
  input: RelationChangeInput,
): Promise<void> {
  validateRelationChange(input);
  await trx
    .withTables<GrowthLogTables>()
    .withSchema('app')
    .insertInto('relation_change_logs')
    .values({
      app_id: input.app_id,
      user_id: input.user_id,
      from_parent_id: input.from_parent_id,
      to_parent_id: input.to_parent_id,
      source: input.source,
      operator: input.operator,
      reason: input.reason,
      at: input.at,
      // D10-118 / BR-CALC-12: created_at carries the same injected-Clock instant as at, never
      // the DB transaction start, so replay by either column gives the same parent.
      created_at: input.at,
    })
    .execute();
}

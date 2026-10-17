// growth change-log writers (B1-11b): insert one row into app.level_change_logs /
// app.relation_change_logs inside the caller's transaction (never opening or committing one),
// after the input checks; database errors propagate unchanged. users is never written here.
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
    })
    .execute();
}

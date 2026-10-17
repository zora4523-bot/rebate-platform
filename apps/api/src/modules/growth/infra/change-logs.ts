// growth change-log writers (B1-11b skeleton): insert one row into app.level_change_logs /
// app.relation_change_logs inside the caller's transaction (never opening or committing one),
// after the input checks; database errors propagate unchanged. users is never written here.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { LevelChangeInput, RelationChangeInput } from '../domain/change-logs.ts';

export function appendLevelChange(trx: Transaction<DB>, input: LevelChangeInput): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: appendLevelChange');
}

export function appendRelationChange(
  trx: Transaction<DB>,
  input: RelationChangeInput,
): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: appendRelationChange');
}

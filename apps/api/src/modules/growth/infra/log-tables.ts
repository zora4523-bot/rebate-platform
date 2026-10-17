import type { Generated } from 'kysely';
import type { LevelChangeInput, RelationChangeInput } from '../domain/change-logs.ts';

// Narrow query shapes while B1-11a's generated DB types are pending. withTables preserves the
// caller's executor; it does not create a connection or a transaction. Omit DB-defaulted audit
// columns (created_at) from inserts, and never let a caller provide the generated id.
// TODO(规划/11 §2.3): use generated DB log types — blocked on B1-11a schema snapshot.
export type GrowthLogTables = {
  level_change_logs: LevelChangeInput & { id: Generated<bigint> };
  relation_change_logs: RelationChangeInput & { id: Generated<bigint> };
};

// growth as-of readers (B1-11b skeleton; BR-INV-11, BR-INV-14, BR-CALC-12): replay the change
// logs at an instant with the executor given on each call (the pool or the caller's transaction).
// levelAt: last level log with effective_at ≤ at (effective_at DESC, id DESC); none → L1, missing
// and a warning growth_level_log_missing. parentAt: last relation log with at ≤ T (at DESC,
// id DESC) → to_parent_id; none → null. Read-only, uncached, no configuration, no users table.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { RootLogger } from '../../platform/index.ts';
import type { AsOfQuery, LevelAt } from '../domain/change-logs.ts';

export type GrowthExecutor = Kysely<DB> | Transaction<DB>;

export interface GrowthHistoryOptions {
  readonly logger: RootLogger;
}

export interface GrowthHistory {
  levelAt(db: GrowthExecutor, query: AsOfQuery): Promise<LevelAt>;
  parentAt(db: GrowthExecutor, query: AsOfQuery): Promise<string | null>;
}

export function createGrowthHistory(options: GrowthHistoryOptions): GrowthHistory {
  void options;
  throw new Error('NotImplemented: createGrowthHistory');
}

// growth as-of readers (B1-11b; BR-INV-11, BR-INV-14, BR-CALC-12): replay the change
// logs at an instant with the executor given on each call (the pool or the caller's transaction).
// levelAt: last level log with effective_at ≤ at (effective_at DESC, id DESC); none → L1, missing
// and a warning growth_level_log_missing. parentAt: last relation log with at ≤ T (at DESC,
// id DESC) → to_parent_id; none → null. Read-only, uncached, no configuration, no users table.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { RootLogger } from '../../platform/index.ts';
import {
  isUserLevel,
  validateAsOfQuery,
  type AsOfQuery,
  type LevelAt,
} from '../domain/change-logs.ts';
import type { GrowthLogTables } from './log-tables.ts';

export type GrowthExecutor = Kysely<DB> | Transaction<DB>;

export interface GrowthHistoryOptions {
  readonly logger: RootLogger;
}

export interface GrowthHistory {
  levelAt(db: GrowthExecutor, query: AsOfQuery): Promise<LevelAt>;
  parentAt(db: GrowthExecutor, query: AsOfQuery): Promise<string | null>;
}

export function createGrowthHistory(options: GrowthHistoryOptions): GrowthHistory {
  return {
    async levelAt(db, query) {
      validateAsOfQuery(query);
      const row = await db
        .withTables<GrowthLogTables>()
        .withSchema('app')
        .selectFrom('level_change_logs')
        .select('to_level')
        .where('app_id', '=', query.app_id)
        .where('user_id', '=', query.user_id)
        .where('effective_at', '<=', query.at)
        .orderBy('effective_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) {
        options.logger.warn(
          { app_id: query.app_id, user_id: query.user_id },
          'growth_level_log_missing',
        );
        return { level: 'L1', missing: true };
      }
      if (!isUserLevel(row.to_level)) {
        throw new Error(
          `level_change_logs.to_level holds a value outside user_level: ${JSON.stringify(row.to_level)}`,
        );
      }
      return { level: row.to_level, missing: false };
    },
    async parentAt(db, query) {
      validateAsOfQuery(query);
      const row = await db
        .withTables<GrowthLogTables>()
        .withSchema('app')
        .selectFrom('relation_change_logs')
        .select('to_parent_id')
        .where('app_id', '=', query.app_id)
        .where('user_id', '=', query.user_id)
        .where('at', '<=', query.at)
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row?.to_parent_id ?? null;
    },
  };
}

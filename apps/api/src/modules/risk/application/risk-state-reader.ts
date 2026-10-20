// Risk's batch risk-state reader for the funds lane (task B1-02zf §9.2 #3, #4): the posting chain
// re-reads each beneficiary's risk state inside its own transaction. One statement on the executor
// the caller passes (its uncommitted writes are visible): app.users left join app.user_risk_state
// on (user_id, app_id), filtered by app_id and id = ANY(deduplicated ids). Only users that exist for
// this app_id are returned; a user without a risk-state row → { state: 'normal', frozen_until: null }.
// state and frozen_until are returned as stored: whether a freeze has expired is the caller's call
// on its own clock (this reader reads no Clock). A state outside the column's CHECK is a broken
// database and throws. The `db` option is kept for the agreed signature and never runs a query.
// No locks, no writes, no logging.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export interface RiskStateBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface RiskStateBatchValue {
  readonly state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly frozen_until: Date | null;
}

export interface RiskStateBatchReaderOptions {
  readonly db: Kysely<DB>;
}

export interface RiskStateBatchReader {
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: RiskStateBatchInput,
  ): Promise<ReadonlyMap<string, RiskStateBatchValue>>;
}

const STATES: ReadonlySet<string> = new Set(['normal', 'frozen', 'appealing', 'banned']);

function toValue(state: string | null, frozenUntil: Date | null): RiskStateBatchValue {
  if (state === null) return { state: 'normal', frozen_until: null };
  // The column has a CHECK; anything else is a broken database, never "normal".
  if (!STATES.has(state)) throw new Error('risk: unknown user risk state');
  return { state: state as RiskStateBatchValue['state'], frozen_until: frozenUntil };
}

export function createRiskStateBatchReader(
  options: RiskStateBatchReaderOptions,
): RiskStateBatchReader {
  // Kept for the agreed signature only: queries always run on the caller's executor.
  void options;
  return Object.freeze({
    async read(executor: Transaction<DB> | Kysely<DB>, input: RiskStateBatchInput) {
      const ids = [...new Set(input.userIds)];
      const result = new Map<string, RiskStateBatchValue>();
      if (ids.length === 0) return result;
      const rows = await executor
        .withSchema('app')
        .selectFrom('users')
        .leftJoin('user_risk_state', (join) =>
          join
            .onRef('user_risk_state.user_id', '=', 'users.id')
            .onRef('user_risk_state.app_id', '=', 'users.app_id'),
        )
        .select(['users.id', 'user_risk_state.state', 'user_risk_state.frozen_until'])
        .where('users.app_id', '=', input.appId)
        .where('users.id', '=', sql<string>`ANY(${ids})`)
        .execute();
      for (const row of rows) result.set(row.id, toValue(row.state, row.frozen_until));
      return result;
    },
  });
}

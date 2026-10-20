// Identity's batch realname-status reader for the funds lane (task B1-02zf §9.2 #2, #4): the posting
// chain re-reads each beneficiary's realname status inside its own transaction. One statement on the
// executor the caller passes (its uncommitted writes are visible): app.users left join app.realname
// on (app_id, user_id), filtered by app_id and id = ANY(deduplicated ids). Only users that exist for
// this app_id are returned; a user without a realname row → 'none'. A status outside the column's
// CHECK is a broken database and throws (as createRealnameStatusReader does). The `db` option is
// kept for the agreed signature and never runs a query. No locks, no writes, no logging, no
// sensitive columns.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { RealnameStatus } from '../application/identity-level.ts';

export interface RealnameStatusBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface RealnameStatusBatchReaderOptions {
  readonly db: Kysely<DB>;
}

export interface RealnameStatusBatchReader {
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: RealnameStatusBatchInput,
  ): Promise<ReadonlyMap<string, RealnameStatus>>;
}

const STATUSES: ReadonlySet<string> = new Set(['none', 'verified', 'failed']);

function toRealnameStatus(status: string | null): RealnameStatus {
  if (status === null) return 'none';
  // The column has a CHECK; anything else is a broken database, never "not verified".
  if (!STATUSES.has(status)) throw new Error('identity: unknown realname status');
  return status as RealnameStatus;
}

export function createRealnameStatusBatchReader(
  options: RealnameStatusBatchReaderOptions,
): RealnameStatusBatchReader {
  // Kept for the agreed signature only: queries always run on the caller's executor.
  void options;
  return Object.freeze({
    async read(executor: Transaction<DB> | Kysely<DB>, input: RealnameStatusBatchInput) {
      const ids = [...new Set(input.userIds)];
      const result = new Map<string, RealnameStatus>();
      if (ids.length === 0) return result;
      const rows = await executor
        .withSchema('app')
        .selectFrom('users')
        .leftJoin('realname', (join) =>
          join
            .onRef('realname.user_id', '=', 'users.id')
            .onRef('realname.app_id', '=', 'users.app_id'),
        )
        .select(['users.id', 'realname.status'])
        .where('users.app_id', '=', input.appId)
        .where('users.id', '=', sql<string>`ANY(${ids})`)
        .execute();
      for (const row of rows) result.set(row.id, toRealnameStatus(row.status));
      return result;
    },
  });
}

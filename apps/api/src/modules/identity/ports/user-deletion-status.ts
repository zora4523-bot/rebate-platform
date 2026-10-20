// Identity's read-only deletion-status port (task B1-02ze §9.2 / §10), requested by the funds lane
// for BR-CALC-13 (beneficiary missing or deleted → forfeited). One SELECT of app.users (id, status
// only) on the executor the caller passes, so the caller's uncommitted writes are visible; the
// `db` option is kept for the agreed signature and never runs a query. No writes, no row locks,
// no logging. BR-ID-28: users.status = deleting → processing, deleted → done, anything else
// (normal, any other value) → none; IDs not in app.users for this app_id are omitted.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export type UserDeletionStatus = 'none' | 'processing' | 'done';

export interface UserDeletionStatusInput {
  app_id: string;
  user_ids: readonly string[];
}

export interface UserDeletionStatusReader {
  read(
    executor: Kysely<DB> | Transaction<DB>,
    input: UserDeletionStatusInput,
  ): Promise<ReadonlyMap<string, UserDeletionStatus>>;
}

export interface UserDeletionStatusReaderOptions {
  db: Kysely<DB>;
}

// BR-CALC-13 / BR-ID-28: users.status only (no cooling; the funds lane locks the users row and reads
// that same row). The deletion request's own stage is ports/deletion-stage.ts (B1-15c), on purpose
// not routed through here.
function toDeletionStatus(status: string): UserDeletionStatus {
  if (status === 'deleting') return 'processing';
  if (status === 'deleted') return 'done';
  return 'none';
}

export function createUserDeletionStatusReader(
  options: UserDeletionStatusReaderOptions,
): UserDeletionStatusReader {
  // Kept for the agreed signature only: queries always run on the caller's executor.
  void options;
  return {
    async read(executor, input) {
      const ids = [...new Set(input.user_ids)];
      const result = new Map<string, UserDeletionStatus>();
      if (ids.length === 0) return result;
      const rows = await executor
        .withSchema('app')
        .selectFrom('users')
        .select(['id', 'status'])
        .where('app_id', '=', input.app_id)
        .where('id', '=', sql<string>`ANY(${ids})`)
        .execute();
      for (const row of rows) result.set(row.id, toDeletionStatus(row.status));
      return result;
    },
  };
}

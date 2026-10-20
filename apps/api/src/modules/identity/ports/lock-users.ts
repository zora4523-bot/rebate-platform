// Identity's in-transaction row lock on app.users for the funds lane (task B1-02zf §9.2 #1, D10-93):
// the posting chain locks every beneficiary before it reads their state. One statement on the
// caller's transaction, `SELECT id … ORDER BY id FOR NO KEY UPDATE`: ascending id order so two
// multi-beneficiary postings never deadlock; NO KEY UPDATE (not FOR UPDATE) so the lock stays
// mutually exclusive between lockers yet never blocks the KEY SHARE foreign-key checks of rows that
// reference users (B1-13e). Only id is selected; IDs not in app.users for this app_id are neither
// an error nor returned. Duplicate IDs are bound once; an empty request runs no query. No logging.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export interface LockUsersInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export async function lockUsersForUpdate(
  trx: Transaction<DB> | Kysely<DB>,
  input: LockUsersInput,
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(input.userIds)];
  const locked = new Set<string>();
  if (ids.length === 0) return locked;
  const rows = await trx
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', input.appId)
    .where('id', '=', sql<string>`ANY(${ids})`)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
  for (const row of rows) locked.add(row.id);
  return locked;
}

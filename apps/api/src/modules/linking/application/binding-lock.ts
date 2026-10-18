// F1-07c: the one user lock every writer of a user's union_bindings takes before it reads the
// user's risk state and bindings (ops/tasks/F1-07c.yaml 并发; BR-ID-20, BR-ID-31): the console's
// reset / disable / enable, the ban / unban ports (binding-risk.ts, F1-07d's risk state change takes
// the same lock first), the user's taobao authorization (union-bindings.ts) and the pdd activation
// (pdd-authority.ts).
// - The anchor is app.users (the row always exists, also before the user's first risk state row),
//   locked FOR NO KEY UPDATE: child-table inserts hold users' KEY SHARE, which FOR UPDATE would
//   conflict with (appeal submission, the pdd open's activation) while NO KEY UPDATE does not.
// - Held until the caller's transaction ends; never taken while an upstream call is in flight.
//   Every writer takes it before it updates an existing binding row (lock, then row: no deadlock
//   between them). The user's taobao authorization is the one exception for a new row: it inserts
//   first (the B1-06h unique-index race must stay reachable) and takes the lock after the insert,
//   before its commit, then reads the risk state and rolls its write back when banned
//   (union-bindings.ts). A lock taken inside a savepoint that is rolled back is dropped; the
//   writers take it again (a no-op when held) after their savepoints.
// - user_risk_state is risk's table; linking only reads it here, on the same transaction right
//   after the lock, so a ban committed while it waited is seen (READ COMMITTED). risk/index.ts has
//   no export that reads on a caller's transaction.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Locks the user's row; false when the user does not exist in this app. */
export async function lockBindingUser(
  trx: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/** The user's risk state as committed now, read on the caller's (locked) transaction. */
export async function userBannedOn(
  trx: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('user_risk_state')
    .select('state')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.state === 'banned';
}

/**
 * row_version of a new binding row: after the highest of the user's earlier rows on the platform
 * (contracts: a later row never reuses an earlier row's row_version), 0 for the first row.
 */
export function nextBindingRowVersion(rows: readonly { readonly row_version: number }[]): number {
  let max = -1;
  for (const row of rows) if (row.row_version > max) max = row.row_version;
  return max + 1;
}

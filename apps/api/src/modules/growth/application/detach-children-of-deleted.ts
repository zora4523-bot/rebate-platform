// B1-15n (D10-137; BR-ID-28 "direct children's parent cleared", BR-INV-11): the deletion cleanup
// transaction (B1-15g) calls detachChildrenOfDeleted(trx, { appId, userId, at }) on its own
// transaction. All on the caller's transaction, never opening or committing one:
//   1. one SELECT … ORDER BY id FOR NO KEY UPDATE of app.users WHERE app_id = appId AND
//      parent_id = userId: the direct children are row-locked one by one in id order (users first,
//      before any log row). A concurrent cleanup of the same parent waits on the first row; once
//      the holder commits, READ COMMITTED re-checks parent_id on every locked row and finds none,
//      so the relation is detached exactly once.
//   2. one UPDATE of exactly those rows, still conditioned on parent_id = userId: parent_id,
//      parent_bind_source and parent_bound_at become null (as the same-device review does),
//      self_bind_used is left as it is, updated_at = at, row_version + 1.
//   3. per detached child, in id order, appendRelationChange(from = userId, to = null,
//      source parent_deleted, operator system, reason null, at) — created_at = at (D10-118).
// Re-entrant: no row still has parent_id = userId → { detached: 0 } and nothing is written.
// The deleted user's own row, invite codes, users.status, grandchildren and other apps are never
// touched. No Clock is read (the caller gives at), no event or job is emitted, nothing is logged.
//
// The app-level relation write lock (lockRelationWrites) is not taken: clearing a parent only
// removes edges, so it can never close a cycle, and every other parent_id writer updates the
// child's row under a parent_id condition, which the row locks here serialise.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { appendRelationChange } from '../infra/change-logs.ts';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function detachChildrenOfDeleted(
  trx: Transaction<DB>,
  input: { appId: string; userId: string; at: Date },
): Promise<{ detached: number }> {
  if (
    input == null ||
    !nonBlank(input.appId) ||
    !nonBlank(input.userId) ||
    !(input.at instanceof Date) ||
    !Number.isFinite(input.at.getTime())
  ) {
    throw new TypeError('growth: detachChildrenOfDeleted needs appId, userId and a valid at');
  }
  const { appId, userId, at } = input;

  const children = await trx
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('parent_id', '=', userId)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
  if (children.length === 0) return { detached: 0 };

  const ids = children.map((row) => row.id);
  const updated = await trx
    .withSchema('app')
    .updateTable('users')
    .set({
      parent_id: null,
      parent_bind_source: null,
      parent_bound_at: null,
      updated_at: at,
      row_version: sql<number>`row_version + 1`,
    })
    .where('app_id', '=', appId)
    .where('parent_id', '=', userId)
    .where('id', 'in', ids)
    .returning('id')
    .execute();

  const detachedIds = new Set(updated.map((row) => row.id));
  for (const id of ids) {
    if (!detachedIds.has(id)) continue;
    await appendRelationChange(trx, {
      app_id: appId,
      user_id: id,
      from_parent_id: userId,
      to_parent_id: null,
      source: 'parent_deleted',
      operator: 'system',
      reason: null,
      at,
    });
  }
  return { detached: detachedIds.size };
}

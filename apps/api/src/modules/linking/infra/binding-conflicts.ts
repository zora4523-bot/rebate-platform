// B1-06z: the 30151 conflict log (app.union_binding_conflicts, migration 0025; BR-ID-18, BR-ID-19
// 细则「并发绑定」). linking is its single writer; every call runs on the caller's transaction so a
// write or a resolution commits or rolls back with the decision it belongs to.
// - record: one row per 30151 (kind occupied / cooling / rebind, the account this authorization
//   used, occurred_at = the injected clock). The user's bindings of the platform are read again
//   first: an active one already there writes the row resolved (resolved_at = occurred_at,
//   resolution already_active); the authorization is refused all the same.
// - resolveOnActive: a binding of (app, user, platform) has just become active — every unresolved
//   row of that user and platform (any account) is resolved (bound_active, resolved_at = the
//   clock). Resolved rows, other users, platforms and apps are never touched.
// - hasUnresolved: whether the user has an unresolved row on the platform (relation_conflict).
// couli_app may update only resolved_at and resolution (column grants); the table trigger keeps
// every other column immutable and a resolution written once.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';

export type BindingConflictKind = 'occupied' | 'cooling' | 'rebind';

export interface BindingConflictInput {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string;
  /** The union account this authorization used. */
  readonly accountId: string;
  readonly kind: BindingConflictKind;
  readonly now: Date;
}

/** Writes one conflict row; resolved at once when the user already has an active binding. */
export async function recordBindingConflict(
  executor: Kysely<DB>,
  input: BindingConflictInput,
): Promise<void> {
  const { appId, userId, platform, accountId, kind, now } = input;
  const active = await executor
    .selectFrom('union_bindings')
    .select('id')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', platform)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  await executor
    .insertInto('union_binding_conflicts')
    .values({
      id: newUuidV7(now),
      app_id: appId,
      user_id: userId,
      platform,
      union_account_id: accountId,
      kind,
      occurred_at: now,
      resolved_at: active === undefined ? null : now,
      resolution: active === undefined ? null : 'already_active',
    })
    .execute();
}

/** Resolves every unresolved row of (app, user, platform) as bound_active at `now`. */
export async function resolveBindingConflictsOnActive(
  executor: Kysely<DB>,
  appId: string,
  userId: string,
  platform: string,
  now: Date,
): Promise<void> {
  await executor
    .updateTable('union_binding_conflicts')
    .set({
      // Never before the row's own instant (resolved_order_check), whatever the clock says.
      resolved_at: sql<Date>`GREATEST(occurred_at, ${now}::timestamptz)`,
      resolution: 'bound_active',
    })
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', platform)
    .where('resolved_at', 'is', null)
    .execute();
}

/** Whether (app, user, platform) has an unresolved conflict row (BR-ID-18 relation_conflict). */
export async function hasUnresolvedBindingConflict(
  executor: Kysely<DB>,
  appId: string,
  userId: string,
  platform: string,
): Promise<boolean> {
  const row = await executor
    .selectFrom('union_binding_conflicts')
    .select('id')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', platform)
    .where('resolved_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

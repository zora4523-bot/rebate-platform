// Read-only profile and invitation eligibility queries. Every query is scoped by app and user.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { InviteBackfillActivityPort, MeSubject } from '../ports/invite-backfill-activity.ts';

export function meUser(db: Kysely<DB>, subject: MeSubject) {
  return db
    .withSchema('app')
    .selectFrom('users')
    .select([
      'nickname',
      'avatar',
      'invite_code',
      'parent_id',
      'self_bind_used',
      'phone_hmac',
      'created_at',
    ])
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .executeTakeFirstOrThrow();
}

export async function hasDirectChildren(db: Kysely<DB>, subject: MeSubject): Promise<boolean> {
  const row = await db
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', subject.appId)
    .where('parent_id', '=', subject.userId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Read-only appeal projection, as permitted by B1-02z §9.3 (D4). */
export async function hasBannedAccountAppeal(db: Kysely<DB>, subject: MeSubject): Promise<boolean> {
  const row = await db
    .withSchema('app')
    .selectFrom('appeals')
    .select('id')
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('target_type', '=', 'account')
    .where('status', '=', 'processing')
    .where('prev_risk_state', '=', 'banned')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Shared with B1-20a: attributed orders and claims of every status, never just payable orders. */
export function createInviteBackfillActivityReader(db: Kysely<DB>): InviteBackfillActivityPort {
  return {
    async orderCount(subject) {
      const row = await db
        .withSchema('app')
        .selectFrom('orders')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    // TODO(规划/11 §2.3): 找回申请任意状态读取 — blocked on B1-10 找回申请
    hasClaims: () => Promise.resolve(false),
  };
}

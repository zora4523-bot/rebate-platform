import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely } from 'kysely';

export const TIMEOUT = 30_000;
export const xid = sql<string>`xmin::text`.as('write_xid');

export interface Subject {
  appId: string;
  userId: string;
  platform: string;
  accountId: string;
}

export async function conflict(
  db: Kysely<DB>,
  subject: Subject,
  now: Date,
  extra: Partial<Insertable<DB['union_binding_conflicts']>> = {},
) {
  return db
    .insertInto('union_binding_conflicts')
    .values({
      id: randomUUID(),
      app_id: subject.appId,
      user_id: subject.userId,
      platform: subject.platform,
      union_account_id: subject.accountId,
      kind: 'occupied',
      occurred_at: now,
      resolved_at: null,
      resolution: null,
      ...extra,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function conflicts(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('union_binding_conflicts')
    .selectAll()
    .select(xid)
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export async function newAccount(db: Kysely<DB>, appId: string, platform: string, now: Date) {
  const account = await db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform,
      account_name: 'synthetic-conflict-account',
      status: 'active',
      auth_status: 'active',
      created_at: now,
      updated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return account.id;
}

// users.id is globally unique; each tenant needs a distinct user to satisfy the composite FK.
export async function mirrorTenant(db: Kysely<DB>, subject: Subject, now: Date) {
  const appId = `synthetic_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const userId = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: '合成跨应用用户',
      avatar: 'https://example.test/synthetic-avatar',
      invite_code: 'demo1',
      attr_code: 'demo0001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const accountId = await newAccount(db, appId, subject.platform, now);
  return { ...subject, appId, userId, accountId };
}

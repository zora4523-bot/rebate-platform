// B1-22l (D10-239 ①, BR-ATTR-05 细则「open 业务校验的先后」⑦): with no unreleased binding and no
// active self_buy slot on the platform, the account this authorization uses is the platform's
// earliest-registered union account (union_accounts.created_at, then id, ascending). updated_at
// moves on re-authorization and similar edits and must not decide it.
//
// Every account here has explicit timestamps whose registration order and update order run
// opposite ways, so the old order (updated_at first) and the new one pick different accounts.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export { databaseFixture } from '../open-pdd-auth/database.ts';

export type AuthPlatform = 'taobao' | 'pdd';
export type SiteAuth = 'active' | 'expired';

/** Registered first, but re-authorized last (its updated_at is the latest of the platform). */
export const FIRST_CREATED = new Date('2025-01-01T00:00:00.000Z');
export const FIRST_REAUTHORIZED = new Date('2026-09-01T00:00:00.000Z');
/** Registered later and not touched since, so the old order (updated_at first) picks it. */
export const LATER_CREATED = new Date('2025-06-01T00:00:00.000Z');
export const LATER_UPDATED = new Date('2025-07-01T00:00:00.000Z');

export interface AccountValues {
  readonly appId: string;
  readonly platform: AuthPlatform;
  readonly authStatus: SiteAuth;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly id?: string;
}

export async function insertAccount(db: Kysely<DB>, values: AccountValues): Promise<string> {
  const id = values.id ?? randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: values.appId,
      platform: values.platform,
      account_name: 'synthetic-fallback-account',
      status: 'active',
      auth_status: values.authStatus,
      created_at: values.createdAt,
      updated_at: values.updatedAt,
    })
    .execute();
  return id;
}

/**
 * Two accounts of one platform: `first` (created earliest, updated latest) and `later` (created
 * later, updated earlier). `existing` turns an account a reused fixture already seeded into
 * `first`, rewriting its timestamps and site authorization.
 */
export async function driftedAccounts(
  db: Kysely<DB>,
  appId: string,
  platform: AuthPlatform,
  auth: { readonly first: SiteAuth; readonly later: SiteAuth },
  existing?: string,
): Promise<{ readonly first: string; readonly later: string }> {
  let first: string;
  if (existing === undefined) {
    first = await insertAccount(db, {
      appId,
      platform,
      authStatus: auth.first,
      createdAt: FIRST_CREATED,
      updatedAt: FIRST_REAUTHORIZED,
    });
  } else {
    await db
      .updateTable('union_accounts')
      .set({
        auth_status: auth.first,
        created_at: FIRST_CREATED,
        updated_at: FIRST_REAUTHORIZED,
      })
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('id', '=', existing)
      .execute();
    first = existing;
  }
  const later = await insertAccount(db, {
    appId,
    platform,
    authStatus: auth.later,
    createdAt: LATER_CREATED,
    updatedAt: LATER_UPDATED,
  });
  return { first, later };
}

/** Two fresh UUIDs in ascending order (PostgreSQL compares uuid bytewise, as lowercase hex). */
export function orderedIds(): readonly [string, string] {
  const [x, y] = [randomUUID(), randomUUID()];
  return x < y ? [x, y] : [y, x];
}

let slotSequence = 0;

/** An active promotion slot with its HJY evidence; Taobao pids follow mm_<a>_<site>_<n>. */
export async function activeSlot(
  db: Kysely<DB>,
  values: {
    readonly appId: string;
    readonly platform: AuthPlatform;
    readonly accountId: string;
    readonly pidScene: 'self_buy' | 'share' | 'agent';
  },
) {
  slotSequence += 1;
  const at = LATER_UPDATED;
  return db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: values.appId,
      platform: values.platform,
      union_account_id: values.accountId,
      site_id: values.platform === 'taobao' ? '880' : null,
      pid:
        values.platform === 'taobao'
          ? `mm_990_880_${slotSequence}`
          : `synthetic-fallback-pdd-${slotSequence}`,
      pid_scene: values.pidScene,
      status: 'active',
      hjy_ignore_confirmed_at: at,
      hjy_ignore_evidence_path: 'synthetic/evidence',
      created_at: at,
      updated_at: at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

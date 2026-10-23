// B1-22l (D10-239 ①, BR-ATTR-05 细则「open 业务校验的先后」⑦): with no unreleased binding and no
// active self_buy slot on the platform, the account this authorization uses is the platform's
// earliest-registered union account (union_accounts.created_at, then id, ascending). updated_at
// moves on re-authorization and similar edits and must not decide it.
//
// Every account here has explicit timestamps and ids. driftedAccounts runs registration order and
// update order opposite ways, so the old order (updated_at first) and the new one pick different
// accounts; interleavedAccounts adds a third account so neither "earliest updated" nor "latest
// updated" lands on the earliest-registered one. In both, ordering by id alone picks a wrong one.
import { randomInt, randomUUID } from 'node:crypto';
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
 * Seeds the earliest-registered account of the platform: a new row with `id`, or, when a reused
 * fixture already seeded one (`existing`), that row with its timestamps and site authorization
 * rewritten. Returns its id.
 */
async function placeFirst(
  db: Kysely<DB>,
  values: AccountValues & { readonly id: string },
  existing: string | undefined,
): Promise<string> {
  if (existing === undefined) return insertAccount(db, values);
  await db
    .updateTable('union_accounts')
    .set({
      auth_status: values.authStatus,
      created_at: values.createdAt,
      updated_at: values.updatedAt,
    })
    .where('app_id', '=', values.appId)
    .where('platform', '=', values.platform)
    .where('id', '=', existing)
    .execute();
  return existing;
}

/**
 * Two accounts of one platform: `first` (created earliest, updated latest, higher id) and `later`
 * (created later, updated earlier, lower id). `existing` turns an account a reused fixture already
 * seeded into `first`, rewriting its timestamps and site authorization; `later` then gets an id
 * below it.
 */
export async function driftedAccounts(
  db: Kysely<DB>,
  appId: string,
  platform: AuthPlatform,
  auth: { readonly first: SiteAuth; readonly later: SiteAuth },
  existing?: string,
): Promise<{ readonly first: string; readonly later: string }> {
  const firstId = existing ?? randomUUID();
  const first = await placeFirst(
    db,
    {
      id: firstId,
      appId,
      platform,
      authStatus: auth.first,
      createdAt: FIRST_CREATED,
      updatedAt: FIRST_REAUTHORIZED,
    },
    existing,
  );
  const later = await insertAccount(db, {
    id: idBeside(firstId, 'below'),
    appId,
    platform,
    authStatus: auth.later,
    createdAt: LATER_CREATED,
    updatedAt: LATER_UPDATED,
  });
  return { first, later };
}

/** Registration and update times of interleavedAccounts, in registration order. */
export const INTERLEAVED = {
  first: { createdAt: FIRST_CREATED, updatedAt: new Date('2026-03-01T00:00:00.000Z') },
  second: { createdAt: LATER_CREATED, updatedAt: FIRST_REAUTHORIZED },
  third: {
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: new Date('2025-09-01T00:00:00.000Z'),
  },
} as const;

/**
 * Three accounts of one platform whose update order is not the reverse of their registration
 * order:
 * - `first`: registered first, updated in the middle, middle id (the expected pick);
 * - `second`: registered second, updated last (most recently re-authorized), lowest id;
 * - `third`: registered last, updated first, highest id.
 * So updated_at ascending picks `third`, updated_at descending `second`, created_at descending
 * `third`, id ascending `second`, id descending `third`. `second` and `third` both get
 * `auth.others`. `existing` works as in driftedAccounts.
 */
export async function interleavedAccounts(
  db: Kysely<DB>,
  appId: string,
  platform: AuthPlatform,
  auth: { readonly first: SiteAuth; readonly others: SiteAuth },
  existing?: string,
): Promise<{ readonly first: string; readonly second: string; readonly third: string }> {
  const firstId = existing ?? randomUUID();
  const first = await placeFirst(
    db,
    { id: firstId, appId, platform, authStatus: auth.first, ...INTERLEAVED.first },
    existing,
  );
  const second = await insertAccount(db, {
    id: idBeside(firstId, 'below'),
    appId,
    platform,
    authStatus: auth.others,
    ...INTERLEAVED.second,
  });
  const third = await insertAccount(db, {
    id: idBeside(firstId, 'above'),
    appId,
    platform,
    authStatus: auth.others,
    ...INTERLEAVED.third,
  });
  return { first, second, third };
}

/** Two fresh UUIDs in ascending order (PostgreSQL compares uuid bytewise, as lowercase hex). */
export function orderedIds(): readonly [string, string] {
  const [x, y] = [randomUUID(), randomUUID()];
  return x < y ? [x, y] : [y, x];
}

const HEX = '0123456789abcdef';

/**
 * A fresh uuid that sorts strictly below or above `pivot` (bytewise, i.e. as lowercase hex):
 * it keeps the pivot's digits up to the first one that can move, moves that digit the asked
 * way, and takes the rest from a random uuid.
 */
export function idBeside(pivot: string, side: 'below' | 'above'): string {
  const digits = pivot.toLowerCase();
  const fixed = side === 'below' ? '0' : 'f';
  let at = 0;
  while (at < digits.length && (digits.charAt(at) === '-' || digits.charAt(at) === fixed)) {
    at += 1;
  }
  if (at === digits.length) throw new Error(`synthetic fixture: no uuid ${side} ${pivot}`);
  const value = HEX.indexOf(digits.charAt(at));
  const moved = side === 'below' ? randomInt(0, value) : randomInt(value + 1, 16);
  return digits.slice(0, at) + HEX.charAt(moved) + randomUUID().slice(at + 1);
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

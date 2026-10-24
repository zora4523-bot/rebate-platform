// B1-06zc rule-test fixture (08 BR-ID-28 细则「注销删除与保留范围」: 联盟绑定 blocked（deletion）,
// 已封禁用户保持 ban; BR-ID-20; BR-ID-30 ② link_logs 90 天; identity/ports/deletion-cleanup.ts).
// Rows are written straight into app.* over the caller's Kysely (the business role couli_app of a
// cloned test database, created by the *.int.test.ts itself: depcruise allows @couli/db/testing
// there only). A user in deletion is a users row with status deleting; every binding has its own
// union_accounts row, so the (app_id, union_account_id, platform, relation_id) key never collides.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely';
import { seedUser } from '../../identity/registration/kit.ts';

export type BindingRow = Selectable<DB['union_bindings']>;
export type LinkLogRow = Selectable<DB['link_logs']>;

/** The cleanup step's Clock reading (2026-10-23 12:00 +08:00). */
export const AT = new Date('2026-10-23T04:00:00.000Z');
/** When the fixture rows were written (before AT, so a write at AT is visible). */
export const SEEDED_AT = new Date('2026-10-01T00:00:00.000Z');
export const BOUND_AT = new Date('2026-09-01T00:00:00.000Z');
export const DAY_MS = 86_400_000;

export function shift(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

export function newAppId(): string {
  return `deletion_link_${randomUUID().replaceAll('-', '')}`;
}

export interface Subject {
  readonly appId: string;
  readonly userId: string;
}

/** A user of `appId` (a fresh App unless given); status deleting unless given. */
export async function subject(
  db: Kysely<DB>,
  options: { appId?: string; status?: string } = {},
): Promise<Subject> {
  const appId = options.appId ?? newAppId();
  const userId = await seedUser(db, appId, { status: options.status ?? 'deleting' });
  return { appId, userId };
}

export interface BindingState {
  readonly platform: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  /** BR-ID-28: whether the deletion cleanup turns this row into blocked (deletion). */
  readonly blocks: boolean;
}

/**
 * Every stored status of union_bindings (contracts/enums/identity.yaml union_binding_status, each
 * blocked_reason apart), one platform each so they can live side by side under the
 * (app_id, user_id, platform) key. active / invalid / pending_auth become blocked (deletion);
 * a row already blocked keeps its reason (ban stays ban), released and unbound stay as they are.
 */
export const STATES: readonly BindingState[] = [
  { platform: 'taobao', status: 'active', blocked_reason: null, blocks: true },
  { platform: 'jd', status: 'invalid', blocked_reason: null, blocks: true },
  { platform: 'pdd', status: 'pending_auth', blocked_reason: null, blocks: true },
  { platform: 'meituan', status: 'blocked', blocked_reason: 'ban', blocks: false },
  { platform: 'vip', status: 'blocked', blocked_reason: 'admin_disable', blocks: false },
  { platform: 'douyin', status: 'blocked', blocked_reason: 'deletion', blocks: false },
  { platform: 'eleme', status: 'released', blocked_reason: null, blocks: false },
  { platform: 'kuaishou', status: 'unbound', blocked_reason: null, blocks: false },
];

/** One union_bindings row of `s` (and its own union_accounts row); active taobao by default. */
export async function bind(
  db: Kysely<DB>,
  s: Subject,
  patch: Partial<Insertable<DB['union_bindings']>> = {},
): Promise<BindingRow> {
  const platform = patch.platform ?? 'taobao';
  const status = patch.status ?? 'active';
  const accountId = randomUUID();
  await db
    .withSchema('app')
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: s.appId,
      platform,
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  const released = status === 'released';
  return db
    .withSchema('app')
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: s.userId,
      platform,
      union_account_id: accountId,
      relation_id: randomUUID().replaceAll('-', '').slice(0, 12),
      status,
      blocked_reason: null,
      reason: null,
      row_version: 7,
      bound_at: status === 'unbound' ? null : BOUND_AT,
      released_at: released ? shift(SEEDED_AT, -DAY_MS) : null,
      cooldown_until: released ? shift(SEEDED_AT, 29 * DAY_MS) : null,
      created_at: SEEDED_AT,
      updated_at: SEEDED_AT,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Every state of STATES for `s`, plus an older released taobao row (history kept beside it). */
export async function everyState(db: Kysely<DB>, s: Subject) {
  const rows: { state: BindingState; row: BindingRow }[] = [];
  for (const state of STATES) {
    rows.push({
      state,
      row: await bind(db, s, {
        platform: state.platform,
        status: state.status,
        blocked_reason: state.blocked_reason,
      }),
    });
  }
  const history = await bind(db, s, { platform: 'taobao', status: 'released', row_version: 3 });
  return { rows, history };
}

/** The row BR-ID-28 expects after the cleanup at `at`. */
export function blockedForDeletion(before: BindingRow, at: Date = AT): BindingRow {
  return {
    ...before,
    status: 'blocked',
    blocked_reason: 'deletion',
    row_version: before.row_version + 1,
    updated_at: at,
  };
}

/** The user's union_bindings rows, every status, in id order. */
export function bindingsOf(db: Kysely<DB>, s: Subject): Promise<BindingRow[]> {
  return db
    .withSchema('app')
    .selectFrom('union_bindings')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('user_id', '=', s.userId)
    .orderBy('id')
    .execute();
}

/** Every union_bindings row of one App, in id order. */
export function bindingsOfApp(db: Kysely<DB>, appId: string): Promise<BindingRow[]> {
  return db
    .withSchema('app')
    .selectFrom('union_bindings')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** An open log of `s` (as the clicking user and the opener) at `createdAt`. */
export async function linkLog(db: Kysely<DB>, s: Subject, createdAt: Date): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('link_logs')
    .values({
      app_id: s.appId,
      event: 'open',
      user_id: s.userId,
      opener_user_id: s.userId,
      platform: 'taobao',
      relation_id: 'synthetic-relation',
      result_code: 0,
      created_at: createdAt,
    })
    .execute();
}

/** Every link_logs row of one App, in id order. */
export function linkLogsOf(db: Kysely<DB>, appId: string): Promise<LinkLogRow[]> {
  return db
    .withSchema('app')
    .selectFrom('link_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** Takes the user's row FOR UPDATE on `trx`, as identity's cleanup transaction holds it. */
export async function lockUser(trx: Kysely<DB>, s: Subject): Promise<void> {
  const { rows } = await sql`SELECT id FROM app.users
    WHERE app_id = ${s.appId} AND id = ${s.userId} FOR UPDATE`.execute(trx);
  if (rows.length !== 1) throw new Error('fixture user not found');
}

class Rollback extends Error {}

/** Runs `body` on a transaction that is then rolled back; any other error propagates. */
export async function rolledBack(
  db: Kysely<DB>,
  body: (trx: Transaction<DB>) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await body(trx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

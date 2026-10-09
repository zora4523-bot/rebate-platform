// app.admin_users reads and the login-state writes of the admin console login (F1-06k; 08
// BR-ID-34; F1-06o columns password_must_change, failed_login_count, locked_until). The admin
// module is the only writer of admin_users (规划/02 §4.1). Every write that changes the login state
// together with an audit event runs in one transaction with the audit row (04 §3.2 audit_logs).
//
// Concurrency (ruling §9.2 #3, §9.3 #6): a failure is ONE conditional UPDATE … RETURNING that
// treats an ended lock as a zero count, adds one and sets the lock at the threshold; it matches
// only an unlocked row, so PG's row lock serialises concurrent failures (no lost update) and
// exactly one of them sets the lock. Clearing, the password change and the binding are
// conditional UPDATEs as well (they refuse a locked row).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditInput, Clock } from '../../platform/index.ts';
import { ADMIN_LOCK_MS, ADMIN_LOCK_THRESHOLD, later } from '../domain/login-policy.ts';
import { createAuditWriter } from './audit-writer.ts';

export interface AdminAccount {
  readonly id: string;
  readonly appId: string;
  readonly loginName: string;
  readonly passwordHash: string;
  readonly totpSecretCipher: Buffer | null;
  readonly totpBoundAt: Date | null;
  readonly isSuper: boolean;
  readonly status: string;
  readonly passwordMustChange: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

/** An audit event without its app and actor (the account's). */
export type AccountAudit = Omit<AuditInput, 'appId' | 'actor'>;

export type FailureOutcome =
  /** Counted; not locked yet. */
  | { readonly kind: 'counted'; readonly count: number }
  /** This failure reached the threshold: the lock was set (and audited) by this request. */
  | { readonly kind: 'locked'; readonly lockedUntil: Date }
  /** Already locked by another request (nothing written). */
  | { readonly kind: 'already_locked'; readonly lockedUntil: Date }
  /** The account vanished. */
  | { readonly kind: 'missing' };

export type WriteOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'locked'; readonly lockedUntil: Date }
  | { readonly kind: 'conflict' };

export interface AdminAccounts {
  byLoginName(loginName: string): Promise<AdminAccount | undefined>;
  byId(appId: string, id: string): Promise<AdminAccount | undefined>;
  /** One more consecutive failure; `lockAudit(until)` is appended when it sets the lock. */
  recordFailure(
    account: AdminAccount,
    lockAudit: (lockedUntil: Date) => AccountAudit,
  ): Promise<FailureOutcome>;
  /** One audit event of the account outside the login-state writes (logout). */
  appendAudit(account: AdminAccount, audit: AccountAudit): Promise<void>;
  /** Login completed: clear the counter and the lock, append `audits` (refused while locked). */
  completeLogin(account: AdminAccount, audits: readonly AccountAudit[]): Promise<WriteOutcome>;
  /** Replace the initial password (only while password_must_change is still true). */
  changeInitialPassword(
    account: AdminAccount,
    passwordHash: string,
    audit: AccountAudit,
  ): Promise<WriteOutcome>;
  /** Store the first binding and complete the login (only while unbound and unlocked). */
  bindTotp(
    account: AdminAccount,
    secretCipher: Buffer,
    audits: readonly AccountAudit[],
  ): Promise<WriteOutcome>;
}

const COLUMNS = [
  'id',
  'app_id',
  'login_name',
  'password_hash',
  'totp_secret_cipher',
  'totp_bound_at',
  'is_super',
  'status',
  'password_must_change',
  'failed_login_count',
  'locked_until',
] as const;

interface AccountRow {
  id: string;
  app_id: string;
  login_name: string;
  password_hash: string;
  totp_secret_cipher: Buffer | null;
  totp_bound_at: Date | null;
  is_super: boolean;
  status: string;
  password_must_change: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

function toAccount(row: AccountRow): AdminAccount {
  return {
    id: row.id,
    appId: row.app_id,
    loginName: row.login_name,
    passwordHash: row.password_hash,
    totpSecretCipher: row.totp_secret_cipher,
    totpBoundAt: row.totp_bound_at,
    isSuper: row.is_super,
    status: row.status,
    passwordMustChange: row.password_must_change,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
  };
}

export function createAdminAccounts(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly sensitiveKeys: readonly string[];
}): AdminAccounts {
  const { db, clock, sensitiveKeys } = deps;

  const append = async (
    trx: Transaction<DB>,
    account: AdminAccount,
    audits: readonly AccountAudit[],
  ): Promise<void> => {
    const writer = createAuditWriter({ db: trx, clock, sensitiveKeys });
    for (const audit of audits) {
      await writer.append({ ...audit, appId: account.appId, actor: account.id });
    }
  };

  /** The lock in force on the row now, for a conditional write that matched nothing. */
  const currentLock = async (
    handle: Kysely<DB>,
    account: AdminAccount,
    now: Date,
  ): Promise<Date | null> => {
    const row = await handle
      .selectFrom('admin_users')
      .select('locked_until')
      .where('app_id', '=', account.appId)
      .where('id', '=', account.id)
      .executeTakeFirst();
    const until = row?.locked_until ?? null;
    return until !== null && until.getTime() > now.getTime() ? until : null;
  };

  const notWritten = async (
    handle: Kysely<DB>,
    account: AdminAccount,
    now: Date,
  ): Promise<WriteOutcome> => {
    const lockedUntil = await currentLock(handle, account, now);
    return lockedUntil === null ? { kind: 'conflict' } : { kind: 'locked', lockedUntil };
  };

  return {
    async byLoginName(loginName) {
      const row = await db
        .selectFrom('admin_users')
        .select(COLUMNS)
        .where('login_name', '=', loginName)
        .executeTakeFirst();
      return row === undefined ? undefined : toAccount(row);
    },

    async byId(appId, id) {
      const row = await db
        .selectFrom('admin_users')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toAccount(row);
    },

    async recordFailure(account, lockAudit) {
      const now = clock.now();
      const lockUntil = later(now, ADMIN_LOCK_MS);
      return await db.transaction().execute(async (trx): Promise<FailureOutcome> => {
        // An ended lock counts as zero failures (BR-ID-34: after the lock the count restarts).
        const base = sql<number>`(case when locked_until is not null and locked_until <= ${now} then 0 else failed_login_count end)`;
        const row = await trx
          .updateTable('admin_users')
          .set({
            failed_login_count: sql<number>`${base} + 1`,
            locked_until: sql<Date | null>`case when ${base} + 1 >= ${ADMIN_LOCK_THRESHOLD} then ${lockUntil}::timestamptz else null end`,
            updated_at: now,
          })
          .where('app_id', '=', account.appId)
          .where('id', '=', account.id)
          .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
          .returning(['failed_login_count', 'locked_until'])
          .executeTakeFirst();
        if (row === undefined) {
          const lockedUntil = await currentLock(trx, account, now);
          return lockedUntil === null
            ? { kind: 'missing' }
            : { kind: 'already_locked', lockedUntil };
        }
        if (row.locked_until !== null) {
          await append(trx, account, [lockAudit(row.locked_until)]);
          return { kind: 'locked', lockedUntil: row.locked_until };
        }
        return { kind: 'counted', count: row.failed_login_count };
      });
    },

    async appendAudit(account, audit) {
      await createAuditWriter({ db, clock, sensitiveKeys }).append({
        ...audit,
        appId: account.appId,
        actor: account.id,
      });
    },

    async completeLogin(account, audits) {
      const now = clock.now();
      return await db.transaction().execute(async (trx): Promise<WriteOutcome> => {
        const result = await trx
          .updateTable('admin_users')
          .set({ failed_login_count: 0, locked_until: null, updated_at: now })
          .where('app_id', '=', account.appId)
          .where('id', '=', account.id)
          .where('status', '=', account.status)
          .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) return await notWritten(trx, account, now);
        await append(trx, account, audits);
        return { kind: 'written' };
      });
    },

    async changeInitialPassword(account, passwordHash, audit) {
      const now = clock.now();
      return await db.transaction().execute(async (trx): Promise<WriteOutcome> => {
        const result = await trx
          .updateTable('admin_users')
          .set({ password_hash: passwordHash, password_must_change: false, updated_at: now })
          .where('app_id', '=', account.appId)
          .where('id', '=', account.id)
          .where('password_must_change', '=', true)
          .where('password_hash', '=', account.passwordHash)
          .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) return await notWritten(trx, account, now);
        await append(trx, account, [audit]);
        return { kind: 'written' };
      });
    },

    async bindTotp(account, secretCipher, audits) {
      const now = clock.now();
      return await db.transaction().execute(async (trx): Promise<WriteOutcome> => {
        const result = await trx
          .updateTable('admin_users')
          .set({
            totp_secret_cipher: secretCipher,
            totp_bound_at: now,
            failed_login_count: 0,
            locked_until: null,
            updated_at: now,
          })
          .where('app_id', '=', account.appId)
          .where('id', '=', account.id)
          .where('totp_bound_at', 'is', null)
          .where('password_must_change', '=', false)
          .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) return await notWritten(trx, account, now);
        await append(trx, account, audits);
        return { kind: 'written' };
      });
    },
  };
}

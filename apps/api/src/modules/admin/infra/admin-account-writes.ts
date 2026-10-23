// app.admin_users writes of the super admin's account management (B1-34h; contract CT-24o
// adminCreateAdmin, adminRegenerateAdminInitialPassword, adminDisableAdmin, adminEnableAdmin,
// adminResetAdminTotp, adminUpdateAdminDisplayName; 08 BR-ID-43, BR-ID-42, BR-ID-34). The admin
// module is the only writer of admin_users (规划/02 §4.1).
//
// Every write is one transaction: the target row is locked (SELECT … FOR UPDATE, scoped to the
// app) and judged, the row is changed (row_version + 1), the audit row is inserted with the same
// transaction handle; disable also cancels the target's pending / running exports through the
// export canceller on that handle; disable, authenticator reset and initial password regeneration
// finally record the account's voiding instant (Redis, ./admin-revocations.ts) before the commit,
// so a failing Redis rolls the change back (50001) and a committed change has always voided. The
// account is re-read inside the transaction for the answer. Admin accounts have no generated
// state machine (not in specs/state-machines): status moves only by the conditional UPDATEs here.
//
// B1-34k adds the permission point save (adminSaveAdminPermissions): the same lock, then a CAS on
// the caller's expected_row_version (20902 admin_account when it differs), the set difference of
// admin_permissions deleted and inserted (kept rows untouched), row_version + 1 and one audit row
// with the points before and after and the added and removed keys. Sessions are not voided: the
// permission guard reads the points on every request.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { ExportCanceller } from '../application/export-worker.ts';
import { createAdminDirectory, type AdminDirectoryRow } from './admin-directory.ts';
import type { AdminRevocations } from './admin-revocations.ts';
import { createAuditWriter } from './audit-writer.ts';

export const ADMIN_ACCOUNT_STATUS = Object.freeze({ active: 'active', disabled: 'disabled' });

/** Audit actions of these writes (contract CT-24o). */
export const ADMIN_ACCOUNT_AUDIT = Object.freeze({
  create: 'admin_account_create',
  regenerate: 'admin_initial_password_regenerate',
  disable: 'admin_account_disable',
  enable: 'admin_account_enable',
  reset: 'admin_totp_reset',
  rename: 'admin_display_name_update',
  permissions: 'admin_permissions_save',
});

/** Why a write was refused (nothing written). */
export type AccountRefusal =
  /** Unknown id or an account of another app: 20001 admin_id. */
  | 'unknown'
  /** A super admin target (the caller included) or the caller's own account: 10403. */
  | 'forbidden'
  /** The account is not in the state the operation needs: 20902 admin_account. */
  | 'conflict';

export type AccountWriteResult =
  | { readonly kind: 'written'; readonly row: AdminDirectoryRow }
  | { readonly kind: 'refused'; readonly reason: AccountRefusal };

export type CreateResult =
  | { readonly kind: 'written'; readonly row: AdminDirectoryRow }
  /** The login name is taken (any app, disabled accounts included): 20001 username. */
  | { readonly kind: 'username_taken' };

interface Actor {
  readonly appId: string;
  /** The super admin doing it (audit_logs.admin_id). */
  readonly actor: string;
  readonly ip: string | null;
}

interface Target extends Actor {
  readonly adminId: string;
}

export interface AdminAccountWrites {
  create(
    input: Actor & {
      readonly id: string;
      readonly loginName: string;
      readonly displayName: string;
      readonly passwordHash: string;
    },
  ): Promise<CreateResult>;
  regenerate(input: Target & { readonly passwordHash: string }): Promise<AccountWriteResult>;
  disable(input: Target & { readonly reason: string }): Promise<AccountWriteResult>;
  enable(input: Target): Promise<AccountWriteResult>;
  resetTotp(input: Target & { readonly reason: string }): Promise<AccountWriteResult>;
  rename(input: Target & { readonly displayName: string }): Promise<AccountWriteResult>;
  /**
   * Replaces the ticked points of an ordinary account with `permissions` (known keys, each once,
   * already checked by the caller) when its row_version is `expectedRowVersion`.
   */
  savePermissions(
    input: Target & {
      readonly permissions: readonly string[];
      readonly expectedRowVersion: number;
    },
  ): Promise<AccountWriteResult>;
}

interface LockedRow {
  readonly id: string;
  readonly is_super: boolean;
  readonly status: string;
  readonly password_must_change: boolean;
  readonly totp_bound_at: Date | null;
  readonly display_name: string | null;
  readonly row_version: number;
}

const targetOf = (adminId: string): string => `admin_users:${adminId}`;

export interface PermissionDiff {
  /** The ticked keys before the save (sorted, every stored key, known or not). */
  readonly before: string[];
  /** The ticked keys after the save (sorted). */
  readonly after: string[];
  /** Keys of `after` not held before (sorted): inserted. */
  readonly added: string[];
  /** Keys held before and not in `after` (sorted): deleted. */
  readonly removed: string[];
}

/** The set difference of a whole-set save; rows of keys in both sets stay untouched. */
export function permissionDiff(held: Iterable<string>, wanted: Iterable<string>): PermissionDiff {
  const before = [...new Set(held)].sort();
  const after = [...new Set(wanted)].sort();
  const had = new Set(before);
  const has = new Set(after);
  return {
    before,
    after,
    added: after.filter((key) => !had.has(key)),
    removed: before.filter((key) => !has.has(key)),
  };
}

/** Thrown inside a transaction to roll it back with a refusal. */
class Refused extends Error {
  readonly reason: AccountRefusal;
  constructor(reason: AccountRefusal) {
    super(`admin account write refused: ${reason}`);
    this.reason = reason;
  }
}

export function createAdminAccountWrites(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly sensitiveKeys: readonly string[];
  readonly exports: ExportCanceller;
  readonly revocations: AdminRevocations;
}): AdminAccountWrites {
  const { db, clock, sensitiveKeys, exports, revocations } = deps;

  const audit = (trx: Transaction<DB>) => createAuditWriter({ db: trx, clock, sensitiveKeys });

  const reread = async (trx: Transaction<DB>, appId: string, id: string) => {
    const row = await createAdminDirectory({ db: trx }).byId(appId, id);
    if (row === undefined) throw new Error('admin: account vanished inside its own transaction');
    return row;
  };

  /**
   * Locks the target, lets `judge` refuse, then runs `write`; a refusal rolls back with nothing
   * written. The answer is the account as re-read in the transaction.
   */
  const onTarget = async (
    input: Target,
    judge: (row: LockedRow) => AccountRefusal | null,
    write: (trx: Transaction<DB>, row: LockedRow, now: Date) => Promise<void>,
  ): Promise<AccountWriteResult> => {
    try {
      return await db.transaction().execute(async (trx): Promise<AccountWriteResult> => {
        const row = await trx
          .selectFrom('admin_users')
          .select([
            'id',
            'is_super',
            'status',
            'password_must_change',
            'totp_bound_at',
            'display_name',
            'row_version',
          ])
          .where('app_id', '=', input.appId)
          .where('id', '=', input.adminId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new Refused('unknown');
        const refusal = judge(row);
        if (refusal !== null) throw new Refused(refusal);
        await write(trx, row, clock.now());
        return { kind: 'written', row: await reread(trx, input.appId, input.adminId) };
      });
    } catch (error) {
      if (error instanceof Refused) return { kind: 'refused', reason: error.reason };
      throw error;
    }
  };

  /** Conditional on the locked row_version: a concurrent write cannot interleave. */
  const update = async (
    trx: Transaction<DB>,
    input: Target,
    row: LockedRow,
    set: Partial<{
      status: string;
      password_hash: string;
      totp_secret_cipher: null;
      totp_bound_at: null;
      totp_last_step: null;
      display_name: string;
    }>,
    now: Date,
  ): Promise<void> => {
    const result = await trx
      .updateTable('admin_users')
      .set({ ...set, row_version: row.row_version + 1, updated_at: now })
      .where('app_id', '=', input.appId)
      .where('id', '=', input.adminId)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('admin: locked account row not updated');
  };

  const voidCredentials = (input: Target, now: Date): Promise<void> =>
    revocations.voidBefore({ appId: input.appId, adminId: input.adminId }, now.getTime());

  /** Super admin rows are 「不可修改」; this also keeps the caller off its own row. */
  const ordinaryOnly = (input: Target, row: LockedRow): AccountRefusal | null =>
    row.is_super || row.id === input.actor ? 'forbidden' : null;

  return {
    async create(input) {
      const now = clock.now();
      return await db.transaction().execute(async (trx): Promise<CreateResult> => {
        const inserted = await trx
          .insertInto('admin_users')
          .values({
            id: input.id,
            app_id: input.appId,
            login_name: input.loginName,
            display_name: input.displayName,
            password_hash: input.passwordHash,
            totp_secret_cipher: null,
            totp_bound_at: null,
            is_super: false,
            status: ADMIN_ACCOUNT_STATUS.active,
            password_must_change: true,
            created_at: now,
            updated_at: now,
          })
          // login_name is unique over every app and every status (BR-ID-43: never given out again).
          .onConflict((oc) => oc.column('login_name').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) return { kind: 'username_taken' };
        await audit(trx).append({
          appId: input.appId,
          actor: input.actor,
          action: ADMIN_ACCOUNT_AUDIT.create,
          target: targetOf(input.id),
          before: null,
          after: {
            admin_id: input.id,
            username: input.loginName,
            display_name: input.displayName,
            is_super: false,
            status: ADMIN_ACCOUNT_STATUS.active,
          },
          ip: input.ip,
        });
        return { kind: 'written', row: await reread(trx, input.appId, input.id) };
      });
    },

    regenerate(input) {
      return onTarget(
        input,
        (row) =>
          ordinaryOnly(input, row) ??
          (row.password_must_change && row.totp_bound_at === null ? null : 'conflict'),
        async (trx, row, now) => {
          await update(trx, input, row, { password_hash: input.passwordHash }, now);
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.regenerate,
            target: targetOf(input.adminId),
            before: null,
            after: { admin_id: input.adminId },
            ip: input.ip,
          });
          await voidCredentials(input, now);
        },
      );
    },

    disable(input) {
      return onTarget(
        input,
        (row) =>
          ordinaryOnly(input, row) ??
          (row.status === ADMIN_ACCOUNT_STATUS.active ? null : 'conflict'),
        async (trx, row, now) => {
          await update(trx, input, row, { status: ADMIN_ACCOUNT_STATUS.disabled }, now);
          await exports.cancelByCreator(trx, {
            appId: input.appId,
            adminId: input.adminId,
            actor: input.actor,
            ip: input.ip,
          });
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.disable,
            target: targetOf(input.adminId),
            before: { status: row.status },
            after: {
              admin_id: input.adminId,
              status: ADMIN_ACCOUNT_STATUS.disabled,
              reason: input.reason,
            },
            ip: input.ip,
          });
          await voidCredentials(input, now);
        },
      );
    },

    enable(input) {
      return onTarget(
        input,
        (row) =>
          ordinaryOnly(input, row) ??
          (row.status === ADMIN_ACCOUNT_STATUS.disabled ? null : 'conflict'),
        async (trx, row, now) => {
          // The voiding instant of the disable stays: what it voided stays void.
          await update(trx, input, row, { status: ADMIN_ACCOUNT_STATUS.active }, now);
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.enable,
            target: targetOf(input.adminId),
            before: { status: row.status },
            after: { admin_id: input.adminId, status: ADMIN_ACCOUNT_STATUS.active },
            ip: input.ip,
          });
        },
      );
    },

    resetTotp(input) {
      return onTarget(
        input,
        // Another super admin may be reset (its lost authenticator); never the caller's own.
        (row) => (row.id === input.actor ? 'forbidden' : null),
        async (trx, row, now) => {
          await update(
            trx,
            input,
            row,
            { totp_secret_cipher: null, totp_bound_at: null, totp_last_step: null },
            now,
          );
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.reset,
            target: targetOf(input.adminId),
            before: { totp_bound: row.totp_bound_at !== null },
            after: { admin_id: input.adminId, totp_bound: false, reason: input.reason },
            ip: input.ip,
          });
          await voidCredentials(input, now);
        },
      );
    },

    rename(input) {
      return onTarget(
        input,
        (row) => ordinaryOnly(input, row),
        async (trx, row, now) => {
          await update(trx, input, row, { display_name: input.displayName }, now);
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.rename,
            target: targetOf(input.adminId),
            before: { display_name: row.display_name },
            after: { admin_id: input.adminId, display_name: input.displayName },
            ip: input.ip,
          });
        },
      );
    },

    savePermissions(input) {
      return onTarget(
        input,
        (row) =>
          ordinaryOnly(input, row) ??
          (row.row_version === input.expectedRowVersion ? null : 'conflict'),
        async (trx, row, now) => {
          const held = (
            await trx
              .selectFrom('admin_permissions')
              .select('permission_key')
              .where('app_id', '=', input.appId)
              .where('admin_id', '=', input.adminId)
              .execute()
          ).map((item) => item.permission_key);
          const diff = permissionDiff(held, input.permissions);
          if (diff.removed.length > 0) {
            await trx
              .deleteFrom('admin_permissions')
              .where('app_id', '=', input.appId)
              .where('admin_id', '=', input.adminId)
              .where('permission_key', 'in', diff.removed)
              .execute();
          }
          if (diff.added.length > 0) {
            await trx
              .insertInto('admin_permissions')
              .values(
                diff.added.map((permission_key) => ({
                  app_id: input.appId,
                  admin_id: input.adminId,
                  permission_key,
                  granted_by: input.actor,
                  granted_at: now,
                  created_at: now,
                })),
              )
              .execute();
          }
          await update(trx, input, row, {}, now);
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_ACCOUNT_AUDIT.permissions,
            target: targetOf(input.adminId),
            before: { permissions: diff.before },
            after: {
              admin_id: input.adminId,
              permissions: diff.after,
              added: diff.added,
              removed: diff.removed,
            },
            ip: input.ip,
          });
        },
      );
    },
  };
}

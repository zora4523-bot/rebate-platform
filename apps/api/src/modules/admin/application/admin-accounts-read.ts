// Read-only admin accounts (F1-06m; contract adminListAdmins / adminGetAdmin; 04 §6.6 admins,
// §11; 08 BR-ID-33). Super admin only: the admin request check (./admin-check.ts) has already
// refused any other account (10403) from the contract's x-auth super, so the use case does not
// check it again. The app is the authenticated principal's; accounts of another app do not exist.
// The verify phone is decrypted with platform/crypto and only its mask leaves this file; the
// password hash and the TOTP secret are never read. Reads only: no write, no audit row.
//
// Pure module (no decorators, erasable syntax).
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import { isAdminId, lockInForce, visiblePermissions } from '../domain/admin-view.ts';
import { maskVerifyPhone, verifyPhoneContext } from '../domain/step-up-policy.ts';
import type { AdminPermission } from '@couli/contracts-ts';
import type { AdminDirectory, AdminDirectoryRow } from '../infra/admin-directory.ts';

export interface AdminAccountView {
  readonly adminId: string;
  readonly username: string;
  /** null when never set (the contract then omits display_name). */
  readonly displayName: string | null;
  readonly isSuper: boolean;
  readonly status: string;
  readonly totpBound: boolean;
  readonly verifyPhoneMasked: string | null;
  readonly lockedUntil: Date | null;
  readonly permissions: AdminPermission[];
  readonly createdAt: Date;
  /** CAS value (admin_users.row_version); answered by the reads and the writes. */
  readonly rowVersion: number;
}

export interface AdminAccountsPage {
  readonly items: AdminAccountView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface AdminAccountsReader {
  /** `page` ≥ 1 and `pageSize` 1–200 (already validated against the contract). */
  list(appId: string, page: number, pageSize: number): Promise<AdminAccountsPage>;
  /** undefined: malformed id, unknown id or an account of another app (all 20001). */
  get(appId: string, adminId: string): Promise<AdminAccountView | undefined>;
}

/** The account as the console sees it; only the verify phone's mask leaves this function. */
export function toAccountView(
  row: AdminDirectoryRow,
  now: Date,
  crypto: Pick<FieldCrypto, 'decrypt'>,
): AdminAccountView {
  return {
    adminId: row.id,
    username: row.loginName,
    displayName: row.displayName,
    isSuper: row.isSuper,
    status: row.status,
    totpBound: row.totpBoundAt !== null,
    verifyPhoneMasked:
      row.verifyPhoneCipher === null
        ? null
        : maskVerifyPhone(
            crypto.decrypt(
              row.verifyPhoneCipher.toString('utf8'),
              verifyPhoneContext({ appId: row.appId, adminId: row.id }),
            ),
          ),
    lockedUntil: lockInForce(row.lockedUntil, now),
    permissions: visiblePermissions(row.isSuper, row.permissionKeys),
    createdAt: row.createdAt,
    rowVersion: row.rowVersion,
  };
}

export function createAdminAccountsReader(deps: {
  readonly clock: Clock;
  readonly directory: AdminDirectory;
  readonly crypto: Pick<FieldCrypto, 'decrypt'>;
}): AdminAccountsReader {
  const { clock, directory, crypto } = deps;

  const view = (row: AdminDirectoryRow, now: Date): AdminAccountView =>
    toAccountView(row, now, crypto);

  return {
    async list(appId, page, pageSize) {
      const total = await directory.count(appId);
      const rows = await directory.page(appId, (page - 1) * pageSize, pageSize);
      const now = clock.now();
      return { items: rows.map((row) => view(row, now)), page, pageSize, total };
    },

    async get(appId, adminId) {
      if (!isAdminId(adminId)) return undefined;
      const row = await directory.byId(appId, adminId);
      return row === undefined ? undefined : view(row, clock.now());
    },
  };
}

// Admin union accounts (B1-22d; BR-ID-24 ③ and 细则「后台联盟账号列表」「后台告警手机号与重新授权会话」
// 「各平台 reauth_mode 的取法」「none 与 manual 平台的到期、探测与提醒」; 编排裁定 D10-152, D10-159,
// D10-164, D10-176, D10-196; contract tag admin-unions, 04 §6.6 union-accounts). union is the only
// writer of union_accounts and union_credentials.
//
// SKELETON (B1-22d test round): bodies throw NotImplemented; the behaviour is fixed by
// contracts/openapi.yaml (adminListUnionAccounts, adminStartUnionReauthorization,
// adminGetUnionReauthorization, adminCompleteUnionReauthorization, adminPutUnionCredential) and the
// rule tests in test/spec/union/admin-accounts/**:
//
// - list: every account of the app (platform, then account_name), with the derived reauth_mode
//   (B1-22c reauthMode), alert_phones_configured (union.auth_alert_phones decodes to a non-empty
//   list) and auth_expires_estimated as stored; never alert_stage or a credential.
// - start / result / callback: B1-22c createSiteReauth; SiteReauthError and the callback's
//   `invalid` are mapped to the contract's 20001 (data.fields, data.reason=manual_mode). The
//   callback only finishes a session of the signed-in admin of the same app; a session that is no
//   longer pending is answered as it is. Audit actions union_account_reauthorize_start /
//   union_account_reauthorize.
// - putCredential (reauth_mode manual only): the plaintext only goes into FieldCrypto
//   (union_credentials.access); the current credential is rotated, auth_expires_at is the given
//   expiry or now + the platform's registered Key validity (estimated), auth_renewed_at / by,
//   auth_status and alert_stage are recomputed, and an audit row union_account_credential (never
//   the credential) is written, all in one transaction. The union is not called.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import type { SiteReauth } from '../auth-expiry/reauth.ts';
import type { UnionAuditWriter } from '../pids/service.ts';

export type AdminUnionAccount = Schema<'AdminUnionAccount'>;
export type AdminUnionReauthSession = Schema<'AdminUnionReauthSession'>;
export type AdminUnionReauthResult = Schema<'AdminUnionReauthResult'>;

/** The signed-in admin of the request. */
export interface AdminUnionAccountActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminUnionAccountsOptions {
  /** Absent in isolated HTTP unit tests: every call fails closed. */
  readonly db: Kysely<DB> | undefined;
  readonly clock: Clock;
  readonly crypto: FieldCrypto | undefined;
  readonly config: (db: Kysely<DB>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  readonly auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  readonly reauth: SiteReauth | null;
}

/** Refusal mapped to 20001 with data.fields (and data.reason=manual_mode when set). */
export class AdminUnionAccountFieldsError extends Error {
  constructor(fields: readonly string[], reason: 'manual_mode' | null) {
    super('NotImplemented');
    void fields;
    void reason;
    throw new Error('NotImplemented: AdminUnionAccountFieldsError');
  }
}

export class AdminUnionAccounts {
  constructor(options: AdminUnionAccountsOptions) {
    void options;
    throw new Error('NotImplemented: AdminUnionAccounts');
  }

  list(appId: string): Promise<AdminUnionAccount[]> {
    void appId;
    throw new Error('NotImplemented: AdminUnionAccounts.list');
  }

  start(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    body: Schema<'AdminUnionReauthorizeRequest'>,
  ): Promise<AdminUnionReauthSession> {
    void actor;
    void unionAccountId;
    void body;
    throw new Error('NotImplemented: AdminUnionAccounts.start');
  }

  result(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    sessionId: string,
  ): Promise<AdminUnionReauthResult> {
    void actor;
    void unionAccountId;
    void sessionId;
    throw new Error('NotImplemented: AdminUnionAccounts.result');
  }

  callback(
    actor: AdminUnionAccountActor,
    body: Schema<'AdminUnionOAuthCallbackRequest'>,
  ): Promise<AdminUnionReauthResult> {
    void actor;
    void body;
    throw new Error('NotImplemented: AdminUnionAccounts.callback');
  }

  putCredential(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    body: Schema<'AdminUnionCredentialRequest'>,
  ): Promise<AdminUnionAccount> {
    void actor;
    void unionAccountId;
    void body;
    throw new Error('NotImplemented: AdminUnionAccounts.putCredential');
  }
}

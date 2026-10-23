// app.admin_users verify-phone writes (B1-34i; 08 BR-ID-45, BR-ID-33; contract CT-24o
// adminChangeMyVerifyPhone, adminChangeAdminVerifyPhone, adminSendAdminVerifyPhoneCode). The admin
// module is the only writer of admin_users and audit_logs (规划/02 §4.1).
//
// A change is one transaction, serialised with B1-34h's account writes by the same row lock: the
// target row is locked (SELECT … FOR UPDATE, scoped to the app) and judged, then the pending code
// is checked (and on success consumed, ./verify-phone-codes.ts) while the lock is held, so two
// submissions of one code change the row at most once; only a verified code changes the row
// (cipher, blind index, verify_phone_set_at = now, row_version + 1) and inserts the audit row with
// the same transaction handle. Any refusal rolls back with nothing written. Sessions are not
// revoked (contract). The account is re-read inside the transaction for the answer.
//
// The audit rows carry masked phones only (BR-ID-33; keys ending in `masked` pass the audit
// backstop of ./audit-redaction.ts).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { createAdminDirectory, type AdminDirectoryRow } from './admin-directory.ts';
import { createAuditWriter } from './audit-writer.ts';
import type { VerifyPhoneCodeCheck } from './verify-phone-codes.ts';

/** Audit actions of the verify-phone operations (contract CT-24o). */
export const ADMIN_VERIFY_PHONE_AUDIT = Object.freeze({
  send: 'admin_verify_phone_code_send',
  change: 'admin_verify_phone_change',
});

/** Who made a change, as the audit row records it. */
export const VERIFY_PHONE_CHANGED_BY = Object.freeze({
  self: 'self',
  superAdmin: 'super_admin',
});

export type VerifyPhoneRefusal =
  /** Unknown id or an account of another app: 20001 admin_id. */
  | 'unknown'
  /** A super admin target or the caller's own account on the super admin's route: 10403. */
  | 'forbidden'
  /** A wrong code: 20002. */
  | 'wrong'
  /** No live pending code for this phone (expired, used, replaced, voided): 20003. */
  | 'gone';

export type VerifyPhoneWriteResult =
  | { readonly kind: 'written'; readonly row: AdminDirectoryRow; readonly setAt: Date }
  | { readonly kind: 'refused'; readonly reason: VerifyPhoneRefusal };

export interface VerifyPhoneChange {
  readonly appId: string;
  /** The account doing it (audit_logs.admin_id). */
  readonly actor: string;
  readonly ip: string | null;
  /** The account whose verify phone changes. */
  readonly adminId: string;
  /** True on the super admin's route (ordinary targets only, reason recorded). */
  readonly bySuper: boolean;
  readonly reason: string | null;
  /** The new phone: field cipher text, blind index, display mask. */
  readonly phone: { readonly cipher: string; readonly hmac: string; readonly masked: string };
  /** Display mask of the stored cipher (the phone before). */
  readonly maskedOf: (cipher: Buffer) => string;
  /** Checks and consumes the pending code; runs while the row is locked. */
  readonly verify: () => Promise<VerifyPhoneCodeCheck>;
}

export interface AdminVerifyPhoneWrites {
  change(input: VerifyPhoneChange): Promise<VerifyPhoneWriteResult>;
  /** The audit row of a super admin's send (written before the SMS goes out). */
  auditSend(input: {
    readonly appId: string;
    readonly actor: string;
    readonly ip: string | null;
    readonly adminId: string;
    readonly masked: string;
  }): Promise<void>;
}

const targetOf = (adminId: string): string => `admin_users:${adminId}`;

/** Thrown inside a transaction to roll it back with a refusal. */
class Refused extends Error {
  readonly reason: VerifyPhoneRefusal;
  constructor(reason: VerifyPhoneRefusal) {
    super(`admin verify phone change refused: ${reason}`);
    this.reason = reason;
  }
}

export function createAdminVerifyPhoneWrites(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly sensitiveKeys: readonly string[];
}): AdminVerifyPhoneWrites {
  const { db, clock, sensitiveKeys } = deps;

  const audit = (handle: Kysely<DB> | Transaction<DB>) =>
    createAuditWriter({ db: handle, clock, sensitiveKeys });

  return {
    async change(input) {
      try {
        return await db.transaction().execute(async (trx): Promise<VerifyPhoneWriteResult> => {
          const row = await trx
            .selectFrom('admin_users')
            .select(['id', 'is_super', 'verify_phone_cipher', 'row_version'])
            .where('app_id', '=', input.appId)
            .where('id', '=', input.adminId)
            .forUpdate()
            .executeTakeFirst();
          if (row === undefined) throw new Refused('unknown');
          if (input.bySuper && (row.is_super || row.id === input.actor)) {
            throw new Refused('forbidden');
          }
          const check = await input.verify();
          if (check !== 'ok') throw new Refused(check);

          const now = clock.now();
          const result = await trx
            .updateTable('admin_users')
            .set({
              verify_phone_cipher: Buffer.from(input.phone.cipher, 'utf8'),
              verify_phone_hmac: input.phone.hmac,
              verify_phone_set_at: now,
              row_version: row.row_version + 1,
              updated_at: now,
            })
            .where('app_id', '=', input.appId)
            .where('id', '=', input.adminId)
            .where('row_version', '=', row.row_version)
            .executeTakeFirst();
          if (result.numUpdatedRows !== 1n)
            throw new Error('admin: locked account row not updated');
          await audit(trx).append({
            appId: input.appId,
            actor: input.actor,
            action: ADMIN_VERIFY_PHONE_AUDIT.change,
            target: targetOf(input.adminId),
            before: {
              verify_phone_masked:
                row.verify_phone_cipher === null ? null : input.maskedOf(row.verify_phone_cipher),
            },
            after: {
              admin_id: input.adminId,
              verify_phone_masked: input.phone.masked,
              changed_by: input.bySuper
                ? VERIFY_PHONE_CHANGED_BY.superAdmin
                : VERIFY_PHONE_CHANGED_BY.self,
              ...(input.reason === null ? {} : { reason: input.reason }),
            },
            ip: input.ip,
          });
          const reread = await createAdminDirectory({ db: trx }).byId(input.appId, input.adminId);
          if (reread === undefined) {
            throw new Error('admin: account vanished inside its own transaction');
          }
          return { kind: 'written', row: reread, setAt: now };
        });
      } catch (error) {
        if (error instanceof Refused) return { kind: 'refused', reason: error.reason };
        throw error;
      }
    },

    async auditSend(input) {
      await audit(db).append({
        appId: input.appId,
        actor: input.actor,
        action: ADMIN_VERIFY_PHONE_AUDIT.send,
        target: targetOf(input.adminId),
        before: null,
        after: { admin_id: input.adminId, verify_phone_masked: input.masked },
        ip: input.ip,
      });
    },
  };
}

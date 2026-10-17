// adminRevealUserField (POST /admin/v1/users/{user_id}/reveal; BR-ID-33, 04 §11.1, F1-07a): the
// one way to see a user's phone number in full. The admin operation guard has already checked
// the account, the point pii.reveal_phone and its totp step-up before this runs; here:
//   1. the user is read by (app_id of the admin actor, user_id): another app's user, or none,
//      is 20001 [user_id] (the client's X-App-Id plays no part);
//   2. no bound phone is 20001 [field], nothing shown, no audit;
//   3. the cipher is decrypted (a damaged envelope throws → 50001, never shown);
//   4. one audit row user_pii_reveal {user_id, field, reason} (never the value, the cipher or the
//      blind index) is written and awaited; a failing write throws → 50001, no value;
//   5. only then the value is returned.
// The value is never logged. Only field=phone exists this batch (the route schema refuses any
// other value with 20001 [field]); the identity number comes with the real-name feature.
import type { AuditPort, FieldCrypto } from '../../platform/index.ts';
import { PHONE_CIPHER_CONTEXT } from './registration.ts';

export const USER_PII_REVEAL_ACTION = 'user_pii_reveal';

export type AdminRevealField = 'phone';

/** The stored phone cipher of one user of one app; undefined when (app_id, id) has no user. */
export interface AdminRevealStore {
  phoneCipher(input: {
    readonly appId: string;
    readonly userId: string;
  }): Promise<{ readonly phoneCipher: Uint8Array | null } | undefined>;
}

export interface AdminRevealCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  readonly field: AdminRevealField;
  readonly reason: string;
}

/** A refused request that names its offending fields (20001). */
export class AdminRevealFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`identity: reveal refused (${fields.join(', ')})`);
    this.name = 'AdminRevealFieldsError';
    this.fields = fields;
  }
}

export interface AdminUserRevealDeps {
  readonly store: AdminRevealStore;
  /** Null when this process has no field cipher: every reveal fails closed (50001). */
  readonly crypto: FieldCrypto | null;
  readonly audit: AuditPort;
}

export class AdminUserReveal {
  readonly #deps: AdminUserRevealDeps;

  constructor(deps: AdminUserRevealDeps) {
    this.#deps = deps;
  }

  async reveal(command: AdminRevealCommand): Promise<string> {
    if (command.field !== 'phone') throw new AdminRevealFieldsError(['field']);
    const row = await this.#deps.store.phoneCipher({
      appId: command.appId,
      userId: command.userId,
    });
    if (row === undefined) throw new AdminRevealFieldsError(['user_id']);
    if (row.phoneCipher === null) throw new AdminRevealFieldsError(['field']);
    const crypto = this.#deps.crypto;
    if (crypto === null) throw new Error('identity: reveal needs the field cipher');
    const value = crypto.decrypt(
      Buffer.from(row.phoneCipher).toString('utf8'),
      PHONE_CIPHER_CONTEXT,
    );
    if (value.length === 0 || value.length > 64) {
      throw new Error('identity: decrypted phone has no displayable form');
    }
    await this.#deps.audit.append({
      appId: command.appId,
      actor: command.adminId,
      action: USER_PII_REVEAL_ACTION,
      target: command.userId,
      before: null,
      after: { user_id: command.userId, field: command.field, reason: command.reason },
      ip: command.ip,
    });
    return value;
  }
}

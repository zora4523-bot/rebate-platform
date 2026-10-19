// Recording a consent or its withdrawal (规划/08 BR-ID-12, BR-ID-13; 04 §6.1 POST /v1/consents;
// orchestrator ruling B1-02f §9.2). consent_records is insert-only: every call adds one row, the
// current state of a subject and type is its row with the latest server_at.
//
// Subject: with the token's principal a user-level row (user_id and device_id from the token);
// without one a device-level row whose device_id is X-Device-Id, which must be a registered,
// unrevoked device of the request's app (otherwise 20001 fields=[X-Device-Id]; user_id empty).
// Withdrawing the privacy consent (type=privacy, accepted=false) is always device level, for this
// device (the token's, else X-Device-Id); a user only rides along as user_id. In the same
// transaction every session of the device is revoked (whoever's), its install_secret is revoked
// (devices.revoked_at) and its push tokens are deleted (BR-ID-13); the account itself is kept.
// type=personalization with a principal also sets users.personalization_off = !accepted.
// server_at = created_at = one read of the Clock, taken after the locks; client_at is the device's
// tap time as reported.
//
// Concurrency (B1-02f round 2): a user-level write takes the user's consent lock (lockUserConsents,
// as the logins do), then reads the Clock, inserts and CASes users, so two toggles of one user
// cannot leave personalization_off disagreeing with the latest record. Lock order (B1-11f money
// review r2 S1), the same in every path that takes both: users row (FOR NO KEY UPDATE) → consent
// lock → growth's relation write lock. A user-level write therefore locks the users row before the
// consent lock, never after it; the row lock is FOR NO KEY UPDATE throughout (also in
// setPersonalization), so it never waits on the foreign-key KEY SHARE of a login inserting the
// user's consent_records / login_logs / sessions under the consent lock. A
// withdrawal locks the device row first, the order createSession uses (device row, then sessions),
// so a concurrent login on the device cannot leave a session unrevoked.
//
// clipboard_auto_import (B1-02zc; BR-ID-12 细则, BR-ID-16; orchestrator ruling E33): the purpose
// consent for clipboard auto-recognition is always device level, with or without a token and for
// accepted true or false: subject_type=device, device_id = the device whose signature the
// controller verified (the request must be signed even though the operation is x-signed false;
// 10401 / 10402 come from that check), user_id = the token's uid only as an association. Its
// version is a string (config.clipboard.consent_version), stored in version_label with version=0
// (the CHECK consent_records_version_label_check); every other type takes an integer version and
// leaves version_label empty. A version form that does not pair with the type → 20001
// fields=[version], before any read or write. It touches no other device and no users row, never
// revokes anything (unlike the privacy withdrawal) and never takes part in login_merge
// (domain/login.ts). The subject is the signed device even when the token was issued on another
// device (B1-02zc rule-test review r1 S2); the app (the token's, else X-App-Id) must be the signed
// device's app, else 10403, as stage ③ does on signed routes. Its current state is the row
// of (device_id, type) with the latest server_at.
// Locks: it locks only the device row (FOR UPDATE, re-checking it is still unrevoked: 10402), never
// the users row nor the user's consent lock, so it is outside the users row → consent lock → growth
// order and cannot form a cycle with it: no other path takes a users row or the consent lock while
// waiting on a device row after a consent write of this kind, and this path holds nothing else.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, TokenPrincipal, VerifiedDevice } from '../../platform/index.ts';
import {
  insertConsentRecords,
  lockUserConsents,
  type NewConsentRecord,
} from '../infra/consent-records.ts';
import { instantPlus } from './config-seconds.ts';
import { revokeSessionsByDevice, type SessionRevokeReason } from './revoke-sessions.ts';

export interface ConsentCommand {
  readonly app_id: string;
  readonly device_id?: string;
  readonly principal?: TokenPrincipal;
  readonly body: Schema<'RecordConsentRequest'>;
  /**
   * The device whose request signature the controller verified (BR-ID-09 rules, checked inside the
   * handler for type=clipboard_auto_import only); required for that type, ignored for the others.
   */
  readonly verified_device?: VerifiedDevice;
}

/** The type recorded only at device level, with a string version (BR-ID-12 细则, BR-ID-16). */
export const CLIPBOARD_CONSENT_TYPE = 'clipboard_auto_import';

export interface ConsentService {
  record(
    command: ConsentCommand,
  ): Promise<
    | { readonly code: 0; readonly data: Schema<'EmptyResponse'>['data'] }
    | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
    | { readonly code: 10402 }
    | { readonly code: 10403 }
  >;
}

export interface ConsentOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/** revoke_reason of the sessions a privacy withdrawal ends (the fixed list of revoke-sessions.ts). */
export const PRIVACY_WITHDRAWAL_REVOKE_REASON: SessionRevokeReason = 'device_revoked';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_HEADER_FIELD = 'X-Device-Id';

/**
 * The device row of the app, or undefined. `lock` takes its row lock (FOR UPDATE) first, the same
 * order as createSession (device row, then sessions): a login on this device either commits before
 * the withdrawal reads the sessions (and its session is revoked with them) or waits and then finds
 * the device revoked (BR-ID-13).
 */
async function findDevice(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
  lock: boolean,
): Promise<{ readonly revoked_at: Date | null } | undefined> {
  const query = trx
    .selectFrom('devices')
    .select('revoked_at')
    .where('id', '=', deviceId)
    .where('app_id', '=', appId);
  return (lock ? query.forUpdate() : query).executeTakeFirst();
}

/** BR-ID-13: the device's sessions, install_secret and push tokens end with the withdrawal. */
async function revokeDevice(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
  now: Date,
): Promise<void> {
  // The instant already read for this request: one Clock read per record (BR-ID-12).
  await revokeSessionsByDevice(
    trx,
    { app_id: appId, device_id: deviceId, reason: PRIVACY_WITHDRAWAL_REVOKE_REASON },
    { now: () => now },
  );
  await trx
    .updateTable('devices')
    .set((eb) => ({ revoked_at: now, updated_at: now, row_version: eb('row_version', '+', 1) }))
    .where('id', '=', deviceId)
    .where('app_id', '=', appId)
    .where('revoked_at', 'is', null)
    .execute();
  await trx
    .deleteFrom('push_tokens')
    .where('app_id', '=', appId)
    .where('device_id', '=', deviceId)
    .execute();
}

/**
 * The user's users row lock, taken before the consent lock (lock order above). FOR NO KEY UPDATE:
 * the personalization update changes no key column, and the lock does not block foreign-key checks.
 * Also taken by the labor agreement signature (labor-agreement.ts), in the same order.
 */
export async function lockUserRow(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('app_id', '=', appId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/**
 * users.personalization_off = !accepted (BR-ID-13), a CAS on the row_version read under the row
 * lock (users is a CAS entity, ADR-0001 §4.1). The caller holds the users row lock and then the
 * user's consent lock, so the
 * record just inserted is the user's latest and this value matches it. A user row that is gone is
 * left alone; a CAS that still misses is a server error (50001), the transaction rolls back.
 */
async function setPersonalization(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
  off: boolean,
  now: Date,
): Promise<void> {
  const user = await trx
    .selectFrom('users')
    .select('row_version')
    .where('id', '=', userId)
    .where('app_id', '=', appId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (user === undefined) return;
  const updated = await trx
    .updateTable('users')
    .set({ personalization_off: off, updated_at: now, row_version: user.row_version + 1 })
    .where('id', '=', userId)
    .where('app_id', '=', appId)
    .where('row_version', '=', user.row_version)
    .executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) {
    throw new Error('identity: the locked users row changed before personalization_off was set');
  }
}

export function createConsentService(options: ConsentOptions): ConsentService {
  const { db, clock } = options;
  const invalidDevice = { code: 20001, data: { fields: [DEVICE_HEADER_FIELD] } } as const;
  const invalidVersion = { code: 20001, data: { fields: ['version'] } } as const;

  /**
   * clipboard_auto_import: one device-level row for the verified device (header comment). The
   * device row is locked and re-read, so a revocation committed after the signature check is
   * still answered 10402 and no row is written for a revoked device.
   */
  async function recordClipboard(command: ConsentCommand, versionLabel: string) {
    const { principal, verified_device: device } = command;
    if (device === undefined) {
      throw new Error('identity: a clipboard_auto_import consent needs the verified device');
    }
    // The subject is always the signed device, never the token's device: a token issued on
    // another installation of the same app only rides along as user_id. Another app is 10403
    // (the token's app is X-App-Id after stage ③; its user cannot be associated across apps).
    if ((principal?.app_id ?? command.app_id) !== device.appId) return { code: 10403 } as const;
    const body = command.body;
    return db.transaction().execute(async (trx) => {
      const row = await findDevice(trx, device.appId, device.deviceId, true);
      if (row === undefined || row.revoked_at !== null) return { code: 10402 } as const;
      const now = clock.now();
      const clientAt = instantPlus(now, Date.parse(body.client_at) - now.getTime());
      await insertConsentRecords(trx, [
        {
          app_id: device.appId,
          subject_type: 'device',
          user_id: principal?.uid ?? null,
          device_id: device.deviceId,
          type: CLIPBOARD_CONSENT_TYPE,
          version: 0,
          version_label: versionLabel,
          channel: body.channel,
          accepted: body.accepted,
          client_at: clientAt,
          server_at: now,
          created_at: now,
        },
      ]);
      return { code: 0 as const, data: {} };
    });
  }

  return Object.freeze({
    async record(command: ConsentCommand) {
      const { principal } = command;
      const raw = command.body;
      // The type and the version form pair (BR-ID-12 细则): a string only for clipboard_auto_import,
      // a (positive, per the contract) integer for every other type. Checked before any read or
      // write, so a string such as '1' is never cast to the integer column.
      if (raw.type === CLIPBOARD_CONSENT_TYPE) {
        if (typeof raw.version !== 'string') return invalidVersion;
        return recordClipboard(command, raw.version);
      }
      if (typeof raw.version !== 'number') return invalidVersion;
      const body = { ...raw, type: raw.type, version: raw.version };
      const appId = principal?.app_id ?? command.app_id;
      const withdrawsPrivacy = body.type === 'privacy' && !body.accepted;
      const deviceId = principal?.device_id ?? command.device_id;
      // Without a token the subject is X-Device-Id, checked against devices below.
      const guestDevice = principal === undefined ? deviceId : undefined;
      if (principal === undefined && (guestDevice === undefined || !UUID.test(guestDevice))) {
        return invalidDevice;
      }
      const userLevel = principal !== undefined && !withdrawsPrivacy;
      return db.transaction().execute(async (trx) => {
        // Locks first, then the Clock: writes of one subject follow each other, so the record with
        // the latest server_at is also the last one written (and users matches it).
        // User level: one user's consent writes (and logins, sms-login) serialise on this lock,
        // taken after the users row lock (lock order above).
        if (userLevel) {
          await lockUserRow(trx, appId, principal.uid);
          await lockUserConsents(trx, appId, principal.uid);
        }
        // A withdrawal locks the device row before it reads the sessions (findDevice).
        const device =
          deviceId !== undefined && (withdrawsPrivacy || guestDevice !== undefined)
            ? await findDevice(trx, appId, deviceId, withdrawsPrivacy)
            : undefined;
        if (guestDevice !== undefined && (device === undefined || device.revoked_at !== null)) {
          return invalidDevice;
        }
        const now = clock.now();
        const clientAt = instantPlus(now, Date.parse(body.client_at) - now.getTime());
        const record: NewConsentRecord = {
          app_id: appId,
          subject_type: userLevel ? 'user' : 'device',
          user_id: principal?.uid ?? null,
          device_id: deviceId ?? null,
          type: body.type,
          version: body.version,
          channel: body.channel,
          accepted: body.accepted,
          client_at: clientAt,
          server_at: now,
          created_at: now,
        };
        await insertConsentRecords(trx, [record]);
        if (withdrawsPrivacy && deviceId !== undefined) {
          await revokeDevice(trx, appId, deviceId, now);
        }
        if (body.type === 'personalization' && principal !== undefined) {
          await setPersonalization(trx, appId, principal.uid, !body.accepted, now);
        }
        return { code: 0 as const, data: {} };
      });
    },
  });
}

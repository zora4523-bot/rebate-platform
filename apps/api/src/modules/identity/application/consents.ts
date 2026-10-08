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
// Concurrency (B1-02f round 2): a user-level write first takes the user's consent lock
// (lockUserConsents, as the logins do), then reads the Clock, inserts and CASes users, so two
// toggles of one user cannot leave personalization_off disagreeing with the latest record. A
// withdrawal locks the device row first, the order createSession uses (device row, then sessions),
// so a concurrent login on the device cannot leave a session unrevoked.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
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
}

export interface ConsentService {
  record(
    command: ConsentCommand,
  ): Promise<
    | { readonly code: 0; readonly data: Schema<'EmptyResponse'>['data'] }
    | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
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
 * users.personalization_off = !accepted (BR-ID-13), a CAS on the row_version read under the row
 * lock (users is a CAS entity, ADR-0001 §4.1). The caller holds the user's consent lock, so the
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
    .forUpdate()
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

  return Object.freeze({
    async record(command: ConsentCommand) {
      const { principal, body } = command;
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
        // User level: one user's consent writes (and logins, sms-login) serialise on this lock.
        if (userLevel) await lockUserConsents(trx, appId, principal.uid);
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

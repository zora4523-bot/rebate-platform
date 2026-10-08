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
// server_at = created_at = one read of the Clock; client_at is the device's tap time as reported.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import { insertConsentRecords, type NewConsentRecord } from '../infra/consent-records.ts';
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

/** A registered, unrevoked device of the app. */
async function isLiveDevice(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('devices')
    .select('id')
    .where('id', '=', deviceId)
    .where('app_id', '=', appId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
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
      const now = clock.now();
      const clientAt = instantPlus(now, Date.parse(body.client_at) - now.getTime());
      const userLevel = principal !== undefined && !withdrawsPrivacy;
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
      return db.transaction().execute(async (trx) => {
        if (guestDevice !== undefined && !(await isLiveDevice(trx, appId, guestDevice))) {
          return invalidDevice;
        }
        await insertConsentRecords(trx, [record]);
        if (withdrawsPrivacy && deviceId !== undefined) {
          await revokeDevice(trx, appId, deviceId, now);
        }
        if (body.type === 'personalization' && principal !== undefined) {
          await trx
            .updateTable('users')
            .set((eb) => ({
              personalization_off: !body.accepted,
              updated_at: now,
              row_version: eb('row_version', '+', 1),
            }))
            .where('id', '=', principal.uid)
            .where('app_id', '=', appId)
            .execute();
        }
        return { code: 0 as const, data: {} };
      });
    },
  });
}

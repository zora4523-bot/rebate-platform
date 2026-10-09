// app.devices, written only by identity (规划/02 §4.1; 04 §3.2 devices).
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DB as DB_TOKEN } from '../../platform/index.ts';

export interface NewDevice {
  readonly id: string;
  readonly appId: string;
  readonly deviceHash: string;
  readonly idSource: string;
  readonly platform: string;
  readonly appVersion: string;
  /** UTF-8 bytes of the field-encryption ciphertext of install_secret (migration 0013). */
  readonly installSecretCipher: Buffer;
  /** From the injected Clock: created_at, updated_at and last_seen_at. */
  readonly now: Date;
}

/**
 * How long the check of an unknown insert outcome waits for the insert's transaction to end
 * (PostgreSQL lock_timeout, transaction-local). On timeout the check fails and the caller keeps
 * the reservation (B1-03f).
 */
export const DEVICE_CHECK_LOCK_TIMEOUT = '2000ms';

/**
 * Transaction-level advisory lock of one issued device (app_id, device_id), taken by the insert
 * before it writes the row and by the check of an unknown outcome before it reads it: once the
 * check holds the lock, the insert's transaction has committed or rolled back, so its row is
 * visible or absent for good. The key is the 64-bit hash of a name prefixed by this module and
 * table (one-bigint key space; platform idempotency uses the disjoint two-int4 form).
 */
async function lockIssuedDevice(trx: Transaction<DB>, appId: string, id: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.devices.issue:${appId}:${id}`}, 0))`.execute(
    trx,
  );
}

export interface UnrevokedDevice {
  readonly id: string;
  readonly appId: string;
  /** UTF-8 bytes of the field-encryption ciphertext of install_secret. */
  readonly installSecretCipher: Buffer;
}

@Injectable()
export class DevicesRepository {
  constructor(
    // Absent only in isolated HTTP unit tests that build an entry without database handles.
    @Optional() @Inject(DB_TOKEN) private readonly db: Kysely<DB> | undefined,
  ) {}

  /**
   * The row of an issued, unrevoked device (`revoked_at IS NULL`; devices has no status column),
   * read from the primary on every call so that a revocation applies to the next request.
   * `id` must already be a well-formed UUID (isWellFormedDeviceId).
   */
  async findUnrevoked(id: string): Promise<UnrevokedDevice | undefined> {
    if (this.db === undefined) throw new Error('identity: no database handle in this process');
    const row = await this.db
      .selectFrom('devices')
      .select(['id', 'app_id', 'install_secret_cipher'])
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { id: row.id, appId: row.app_id, installSecretCipher: row.install_secret_cipher };
  }

  /**
   * Whether the device row (app_id, id) exists (revoked or not), read from the primary: the check
   * of a registration whose insert outcome is unknown (B1-03f). It first waits, at most
   * DEVICE_CHECK_LOCK_TIMEOUT, for the device's advisory lock, so a still-running insert
   * transaction is never read as absent; a lock timeout or any other error is thrown (the caller
   * keeps the reservation).
   */
  async exists(appId: string, id: string): Promise<boolean> {
    if (this.db === undefined) throw new Error('identity: no database handle in this process');
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', ${DEVICE_CHECK_LOCK_TIMEOUT}, true)`.execute(trx);
      await lockIssuedDevice(trx, appId, id);
      const row = await trx
        .selectFrom('devices')
        .select('id')
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * A new, unbound, unrevoked device row. Re-registering the same hash adds another row. One
   * transaction holding the device's advisory lock (see exists).
   */
  async insert(device: NewDevice): Promise<void> {
    if (this.db === undefined) throw new Error('identity: no database handle in this process');
    await this.db.transaction().execute(async (trx) => {
      await lockIssuedDevice(trx, device.appId, device.id);
      await trx
        .insertInto('devices')
        .values({
          id: device.id,
          app_id: device.appId,
          user_id: null,
          device_hash: device.deviceHash,
          id_source: device.idSource,
          platform: device.platform,
          app_version: device.appVersion,
          install_secret_cipher: device.installSecretCipher,
          last_login_sid: null,
          revoked_at: null,
          last_seen_at: device.now,
          created_at: device.now,
          updated_at: device.now,
        })
        .execute();
    });
  }
}

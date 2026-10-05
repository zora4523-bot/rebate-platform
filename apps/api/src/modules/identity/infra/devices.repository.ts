// app.devices, written only by identity (规划/02 §4.1; 04 §3.2 devices).
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
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

@Injectable()
export class DevicesRepository {
  constructor(
    // Absent only in isolated HTTP unit tests that build an entry without database handles.
    @Optional() @Inject(DB_TOKEN) private readonly db: Kysely<DB> | undefined,
  ) {}

  /** A new, unbound, unrevoked device row. Re-registering the same hash adds another row. */
  async insert(device: NewDevice): Promise<void> {
    if (this.db === undefined) throw new Error('identity: no database handle in this process');
    await this.db
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
  }
}

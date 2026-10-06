// The risk module's DeviceSigningKeys port (stage ① request signatures, BR-ID-09), implemented by
// identity, the only writer and reader of app.devices (规划/02 §4.1). app.module hands this module to
// RiskModule, which injects DEVICE_SIGNING_KEYS (orchestrator ruling B1-03b §9.3 #2).
//
// - A value that is not a canonical UUID cannot be server-issued: null without a query.
// - Missing or revoked (revoked_at set) → null (10402). Nothing is cached: every request reads the
//   row again, so a revocation applies at once.
// - The install_secret is decrypted with the context bound to the row id, so a ciphertext copied
//   onto another row does not decrypt there. A decryption failure, a process without the keyring or
//   without a database handle is an error (50001), never "unknown device".
import { Inject, Injectable, Optional } from '@nestjs/common';
import { FIELD_CRYPTO, type FieldCrypto } from '../../platform/index.ts';
import type { DeviceSigningKey, DeviceSigningKeys } from '../../risk/index.ts';
import { installSecretContext, isWellFormedDeviceId } from '../domain/device.ts';
import { DevicesRepository } from '../infra/devices.repository.ts';

@Injectable()
export class DeviceSigningKeysService implements DeviceSigningKeys {
  constructor(
    @Inject(DevicesRepository) private readonly devices: DevicesRepository,
    // Absent when the process has no keyring (local / test without FIELD_KEY_PROVIDER).
    @Optional() @Inject(FIELD_CRYPTO) private readonly fieldCrypto: FieldCrypto | undefined,
  ) {}

  async findActive(deviceId: string): Promise<DeviceSigningKey | null> {
    if (!isWellFormedDeviceId(deviceId)) return null;
    const row = await this.devices.findUnrevoked(deviceId);
    if (row === undefined) return null;
    if (this.fieldCrypto === undefined) {
      throw new Error('identity: request signatures need the field-encryption keyring');
    }
    const installSecret = this.fieldCrypto.decrypt(
      row.installSecretCipher.toString('utf8'),
      installSecretContext(row.id),
    );
    return { deviceId: row.id, appId: row.appId, installSecret };
  }
}

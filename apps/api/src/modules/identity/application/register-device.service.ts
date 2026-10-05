// Use case POST /v1/devices (BR-ID-09; 04 §6.1). The request schema has already checked the
// headers, the hash format and id_source; this service applies the invalid-hash list, issues
// device_id and install_secret and stores the row. It sends no job and publishes no event.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DeviceIdSource } from '@couli/contracts-ts';
import {
  CLOCK,
  FIELD_CRYPTO,
  newUuidV7,
  type Clock,
  type FieldCrypto,
} from '../../platform/index.ts';
import { installSecretContext, isRegistrableDeviceHash } from '../domain/device.ts';
import { DevicesRepository } from '../infra/devices.repository.ts';
import { newInstallSecret } from '../infra/issue.ts';

/** Token of the invalid-hash list (config device.invalid_hashes), a ReadonlySet of hashes. */
export const INVALID_DEVICE_HASHES = Symbol('INVALID_DEVICE_HASHES');

export interface RegisterDeviceCommand {
  /** X-App-Id */
  readonly appId: string;
  /** X-Platform */
  readonly platform: string;
  /** X-App-Version */
  readonly appVersion: string;
  readonly deviceHash: string;
  readonly idSource: DeviceIdSource;
}

export type RegisterDeviceResult =
  | {
      readonly kind: 'registered';
      readonly deviceId: string;
      /** Returned to the client once; only its ciphertext is stored. */
      readonly installSecret: string;
    }
  | { readonly kind: 'invalid_device_hash' };

@Injectable()
export class RegisterDeviceService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INVALID_DEVICE_HASHES) private readonly invalidHashes: ReadonlySet<string>,
    @Inject(DevicesRepository) private readonly devices: DevicesRepository,
    // Absent when the process has no keyring (local / test without FIELD_KEY_PROVIDER).
    @Optional() @Inject(FIELD_CRYPTO) private readonly fieldCrypto: FieldCrypto | undefined,
  ) {}

  async register(command: RegisterDeviceCommand): Promise<RegisterDeviceResult> {
    if (!isRegistrableDeviceHash(command.deviceHash, this.invalidHashes)) {
      return { kind: 'invalid_device_hash' };
    }
    if (this.fieldCrypto === undefined) {
      throw new Error('identity: device registration needs the field-encryption keyring');
    }
    const now = this.clock.now();
    const deviceId = newUuidV7(now);
    const installSecret = newInstallSecret();
    const cipher = this.fieldCrypto.encrypt(installSecret, installSecretContext(deviceId));
    await this.devices.insert({
      id: deviceId,
      appId: command.appId,
      deviceHash: command.deviceHash,
      idSource: command.idSource,
      platform: command.platform,
      appVersion: command.appVersion,
      installSecretCipher: Buffer.from(cipher, 'utf8'),
      now,
    });
    return { kind: 'registered', deviceId, installSecret };
  }
}

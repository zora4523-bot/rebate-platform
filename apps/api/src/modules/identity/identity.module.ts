import { Module } from '@nestjs/common';
import { DEVICE_SIGNING_KEYS } from '../risk/index.ts';
import { DeviceSigningKeysService } from './application/device-signing-keys.service.ts';
import {
  INVALID_DEVICE_HASHES,
  RegisterDeviceService,
} from './application/register-device.service.ts';
import { DevicesController } from './http/public/devices.controller.ts';
import { DevicesRepository } from './infra/devices.repository.ts';
import { loadInvalidDeviceHashSeeds } from './infra/invalid-device-hashes.ts';

/**
 * Identity (规划/02 §4.1): devices today; sessions, SMS login and consent records follow.
 * Served by the `api` entry (/v1). The database handle and the field cipher are optional at
 * construction so that entries built without them (isolated HTTP unit tests) still register the
 * routes; a registration that needs them fails at request time instead.
 * Exports the risk module's DEVICE_SIGNING_KEYS port (request signatures, BR-ID-09); app.module
 * passes this module to RiskModule.
 */
@Module({
  controllers: [DevicesController],
  providers: [
    // Read once while the entry starts; a missing or malformed list stops the entry.
    { provide: INVALID_DEVICE_HASHES, useFactory: () => loadInvalidDeviceHashSeeds() },
    DevicesRepository,
    RegisterDeviceService,
    DeviceSigningKeysService,
    { provide: DEVICE_SIGNING_KEYS, useExisting: DeviceSigningKeysService },
  ],
  exports: [DEVICE_SIGNING_KEYS],
})
export class IdentityModule {}

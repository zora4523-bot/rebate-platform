import { Module } from '@nestjs/common';
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
 */
@Module({
  controllers: [DevicesController],
  providers: [
    // Read once while the entry starts; a missing or malformed list stops the entry.
    { provide: INVALID_DEVICE_HASHES, useFactory: () => loadInvalidDeviceHashSeeds() },
    DevicesRepository,
    RegisterDeviceService,
  ],
})
export class IdentityModule {}

import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import {
  APP_CONFIG,
  CLOCK,
  FIELD_CRYPTO,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { DEVICE_SIGNING_KEYS } from '../risk/index.ts';
import { DeviceSigningKeysService } from './application/device-signing-keys.service.ts';
import {
  INVALID_DEVICE_HASHES,
  RegisterDeviceService,
} from './application/register-device.service.ts';
import {
  createSmsCodeService,
  type SmsCodeService,
  type SmsConfigReader,
  type SmsSender,
} from './application/sms-codes.ts';
import { IDENTITY_CONFIG, SMS_CODES } from './application/tokens.ts';
import { DevicesController } from './http/public/devices.controller.ts';
import { SmsCodesController } from './http/public/sms-codes.controller.ts';
import { DevicesRepository } from './infra/devices.repository.ts';
import { createSmsSender, smsSenderToken } from './infra/fake-sms.ts';
import { loadInvalidDeviceHashSeeds } from './infra/invalid-device-hashes.ts';
import { createSmsHmac } from './infra/sms-hmac.ts';

export interface IdentityModuleOptions {
  /**
   * Builds the identity configuration port (business configuration by app and key, e.g.
   * sms.blocked_prefixes): content's reader, assembled by app.module (content implements the port's
   * shape and imports nothing of identity). Null when the process has no database.
   */
  readonly config: Omit<FactoryProvider<SmsConfigReader | null>, 'provide'>;
}

/**
 * Identity (规划/02 §4.1): devices and SMS codes today; sessions, SMS login and consent records
 * follow. Served by the `api` entry (/v1). The database handle, the field cipher and Redis are
 * optional at construction so that entries built without them (isolated HTTP unit tests) still
 * register the routes; a request that needs them fails at request time instead (50001).
 * Exports the risk module's DEVICE_SIGNING_KEYS port (request signatures, BR-ID-09); app.module
 * passes this module to RiskModule.
 * SMS: the sender under smsSenderToken() is the fake adapter in local / test (its outbox is the
 * only way to read a code there); the code service needs Redis and the configuration reader.
 */
@Module({})
export class IdentityModule {
  static forRoot(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [DevicesController, SmsCodesController],
      providers: [
        // Read once while the entry starts; a missing or malformed list stops the entry.
        { provide: INVALID_DEVICE_HASHES, useFactory: () => loadInvalidDeviceHashSeeds() },
        DevicesRepository,
        RegisterDeviceService,
        DeviceSigningKeysService,
        { provide: DEVICE_SIGNING_KEYS, useExisting: DeviceSigningKeysService },
        { ...options.config, provide: IDENTITY_CONFIG },
        {
          provide: smsSenderToken(),
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): SmsSender => createSmsSender(config.appEnv),
        },
        {
          provide: SMS_CODES,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            smsSenderToken(),
            IDENTITY_CONFIG,
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            sender: SmsSender,
            reader: SmsConfigReader | null,
            redis?: RedisHandle,
            fieldCrypto?: FieldCrypto,
          ): SmsCodeService | null =>
            redis === undefined || reader === null
              ? null
              : createSmsCodeService({
                  clock,
                  redis,
                  sender,
                  config: reader,
                  logger,
                  hmac: createSmsHmac(config.appEnv, fieldCrypto),
                }),
        },
      ],
      exports: [DEVICE_SIGNING_KEYS],
    };
  }
}

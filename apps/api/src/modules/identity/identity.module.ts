import { type DynamicModule, type FactoryProvider, HttpException, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RequestCheck,
  type RequestCheckInput,
  type RootLogger,
} from '../platform/index.ts';
import { DEVICE_SIGNING_KEYS, type BlocklistService } from '../risk/index.ts';
import {
  H5_READ_ONLY_MSG,
  createTokenCheck,
  createTokenKeyProvider,
  createTokenService,
  type TokenKeyProvider,
  type TokenService,
} from './application/access-tokens.ts';
import { createConsentService, type ConsentService } from './application/consents.ts';
import { createH5TokenService, type H5TokenService } from './application/h5-token.ts';
import {
  createOauthAttemptService,
  type OauthAttemptService,
} from './application/oauth-attempts.ts';
import {
  createStepUpService,
  type StepUpService,
  type ThirdPartyIdentityPort,
} from './application/step-up.ts';
import { DeviceSigningKeysService } from './application/device-signing-keys.service.ts';
import {
  DEVICE_REGISTRATION_RISK,
  INVALID_DEVICE_HASHES,
  RegisterDeviceService,
  type DeviceRegistrationPorts,
} from './application/register-device.service.ts';
import {
  createSmsCodeService,
  type SmsCodeService,
  type SmsConfigReader,
  type SmsSender,
} from './application/sms-codes.ts';
import { createLogout, type Logout } from './application/logout.ts';
import { createRefreshService, type RefreshService } from './application/refresh.ts';
import {
  createDefaultInviteCodeFilter,
  createRegistrationService,
  type SensitiveWords,
} from './application/registration.ts';
import { createSmsLoginService, type SmsLoginService } from './application/sms-login.ts';
import { identityRiskPorts, type IdentityRiskPorts } from './application/risk-ports.ts';
import type { MinimumVersionReader } from './application/session-scope.ts';
import {
  CONSENTS,
  H5_TOKENS,
  IDENTITY_CONFIG,
  LOGOUT,
  OAUTH_ATTEMPTS,
  REFRESH,
  SMS_CODES,
  SMS_LOGIN,
  STEP_UP,
  THIRD_PARTY_IDENTITY,
  TOKEN_CHECK,
  TOKEN_KEYS,
  TOKEN_SERVICE,
} from './application/tokens.ts';
import { ConsentsController } from './http/public/consents.controller.ts';
import { DevicesController } from './http/public/devices.controller.ts';
import { H5TokenController } from './http/public/h5-token.controller.ts';
import { OauthAttemptsController } from './http/public/oauth-attempts.controller.ts';
import { StepUpController } from './http/public/step-up.controller.ts';
import { LogoutController } from './http/public/logout.controller.ts';
import { RefreshController } from './http/public/refresh.controller.ts';
import { SmsCodesController } from './http/public/sms-codes.controller.ts';
import { SmsLoginController } from './http/public/sms-login.controller.ts';
import { DevicesRepository } from './infra/devices.repository.ts';
import { createSmsSender, smsSenderToken } from './infra/fake-sms.ts';
import { loadInvalidDeviceHashSeeds } from './infra/invalid-device-hashes.ts';
import { createSessionLookup } from './infra/session-lookup.ts';
import { createSmsHmac } from './infra/sms-hmac.ts';

/**
 * The identity configuration port: business configuration by app and key (e.g.
 * sms.blocked_prefixes, BR-ID-05) and the minimum supported version that the session scope of a
 * login or refresh is judged against (BR-ID-01 细则「受限会话」, sessionScope).
 */
export type IdentityConfigReader = SmsConfigReader & MinimumVersionReader;

export interface IdentityModuleOptions {
  /**
   * Builds the identity configuration port (IdentityConfigReader): content's reader, assembled by
   * app.module (content implements the port's shape and imports nothing of identity). Null when
   * the process has no database.
   */
  readonly config: Omit<FactoryProvider<IdentityConfigReader | null>, 'provide'>;
  /**
   * Builds risk's blocklist service (B1-03d), assembled by app.module: SMS send, SMS login before
   * creating an account and the same-device limit use it (application/risk-ports.ts). Null when
   * the process has no database or field cipher; absent, the ports keep their defaults (no
   * blocklist, no release).
   */
  readonly blocklist?: Omit<FactoryProvider<BlocklistService | null>, 'provide'>;
  /**
   * Builds the third-party identity exchange of the step-up by re-authorization (CT-15i performs
   * the exchange and verification, BR-ID-04 细则). Absent (or null), the third-party step-up
   * answers 50305 after the attempt is consumed: no platform answer is ever faked here.
   */
  readonly thirdPartyIdentity?: Omit<FactoryProvider<ThirdPartyIdentityPort | null>, 'provide'>;
  /**
   * Builds risk's device registration ports (B1-03f: per-IP hourly cap, hot device_hash alert),
   * assembled by app.module through risk's index.ts. Absent, every registration is refused with
   * 42901 (never a registration without the cap).
   */
  readonly deviceRegistration?: Omit<FactoryProvider<DeviceRegistrationPorts>, 'provide'>;
}

/** The ports without risk's assembly: refuse like an unavailable store (Retry-After 1). */
const REFUSING_DEVICE_REGISTRATION: DeviceRegistrationPorts = {
  reserve: () => Promise.resolve({ code: 42901, retryAfterSec: 1 }),
  release: () => Promise.resolve(),
  reconcile: () => Promise.resolve(),
  recordSuccess: () => Promise.resolve(),
};

/**
 * 10403 with data.reason=h5_read_only (BR-ID-32 细则「只读作用域」) as an HttpException, which the
 * global error filter writes back with its data (a RequestRejection carries no data).
 */
function h5ReadOnlyRejection(request: RequestCheckInput): HttpException {
  return new HttpException(
    {
      code: 10403,
      msg: H5_READ_ONLY_MSG,
      data: { reason: 'h5_read_only' },
      trace_id: request.id,
    },
    403,
  );
}

/**
 * Identity (规划/02 §4.1): devices, SMS codes, SMS login (B1-02j), session tokens, refresh rotation
 * (B1-02k), logout, and (B1-02f) third-party authorization attempts, step-up, h5_token and consent
 * records. Served by the `api` entry (/v1). The database handle, the field cipher
 * and Redis are optional at construction so that entries built without them (isolated HTTP unit
 * tests) still register the routes; a request that needs them fails at request time instead
 * (50001).
 * Exports the risk module's DEVICE_SIGNING_KEYS port (request signatures, BR-ID-09); app.module
 * passes this module to RiskModule.
 * Exports TOKEN_CHECK, the token stages ② ③ (BR-ID-01) that app.module places right after the
 * signature check in the api entry's REQUEST_CHECKS.
 * SMS: the sender under smsSenderToken() is the fake adapter in local / test (its outbox is the
 * only way to read a code there); the code service needs Redis and the configuration reader.
 * Tokens: the signing key (TOKEN_KEYS) is the configured JWT_* key, or one ephemeral key pair per
 * process in local / test; staging / prod without a key refuse to start. Its factory waits for
 * FIELD_CRYPTO (injected only for that), so a keyring that fails to open is the startup error an
 * entry reports, not the missing JWT key of the same environment.
 */
/** The invite-code sensitive-word filter of the registration core (createDefaultInviteCodeFilter). */
const INVITE_CODE_WORDS = Symbol('INVITE_CODE_WORDS');
/** risk's blocklist service as app.module builds it (IdentityModuleOptions.blocklist), or null. */
const BLOCKLIST_SERVICE = Symbol('IDENTITY_BLOCKLIST_SERVICE');
/** identity's ports onto risk's blocklist (identityRiskPorts), or null without one. */
const RISK_PORTS = Symbol('IDENTITY_RISK_PORTS');

@Module({})
export class IdentityModule {
  static forRoot(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [
        DevicesController,
        SmsCodesController,
        SmsLoginController,
        RefreshController,
        LogoutController,
        OauthAttemptsController,
        StepUpController,
        H5TokenController,
        ConsentsController,
      ],
      providers: [
        // Read once while the entry starts; a missing or malformed list stops the entry.
        { provide: INVALID_DEVICE_HASHES, useFactory: () => loadInvalidDeviceHashSeeds() },
        DevicesRepository,
        options.deviceRegistration === undefined
          ? { provide: DEVICE_REGISTRATION_RISK, useValue: REFUSING_DEVICE_REGISTRATION }
          : { ...options.deviceRegistration, provide: DEVICE_REGISTRATION_RISK },
        RegisterDeviceService,
        DeviceSigningKeysService,
        { provide: DEVICE_SIGNING_KEYS, useExisting: DeviceSigningKeysService },
        { ...options.config, provide: IDENTITY_CONFIG },
        options.blocklist === undefined
          ? { provide: BLOCKLIST_SERVICE, useValue: null }
          : { ...options.blocklist, provide: BLOCKLIST_SERVICE },
        {
          provide: RISK_PORTS,
          inject: [BLOCKLIST_SERVICE, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (
            risk: BlocklistService | null,
            fieldCrypto?: FieldCrypto,
          ): IdentityRiskPorts | null =>
            risk === null || fieldCrypto === undefined
              ? null
              : identityRiskPorts(risk, fieldCrypto),
        },
        {
          provide: smsSenderToken(),
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: RootLogger): SmsSender =>
            createSmsSender(config.appEnv, logger),
        },
        {
          provide: SMS_CODES,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            smsSenderToken(),
            IDENTITY_CONFIG,
            RISK_PORTS,
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            sender: SmsSender,
            reader: SmsConfigReader | null,
            risk: IdentityRiskPorts | null,
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
                  ...(risk === null ? {} : { hooks: risk.smsHooks }),
                }),
        },
        {
          provide: TOKEN_KEYS,
          // FIELD_CRYPTO is resolved first (and unused): Nest creates providers concurrently, and
          // a staging / prod entry whose keyring cannot open must fail with that error.
          inject: [APP_CONFIG, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (config: AppConfig): Promise<TokenKeyProvider> =>
            createTokenKeyProvider(config.appEnv, config.jwt ?? null),
        },
        {
          provide: TOKEN_SERVICE,
          inject: [CLOCK, TOKEN_KEYS],
          useFactory: (clock: Clock, keys: TokenKeyProvider): TokenService =>
            createTokenService({ clock, keys }),
        },
        {
          provide: TOKEN_CHECK,
          inject: [TOKEN_SERVICE, { token: DB, optional: true }],
          useFactory: (tokens: TokenService, db?: Kysely<Database>): RequestCheck =>
            createTokenCheck({
              tokens,
              sessions: createSessionLookup(db),
              readOnlyRejection: h5ReadOnlyRejection,
            }),
        },
        // Read once while the entry starts (the invite-code seed list of the registration core).
        { provide: INVITE_CODE_WORDS, useFactory: () => createDefaultInviteCodeFilter() },
        {
          provide: SMS_LOGIN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            SMS_CODES,
            TOKEN_SERVICE,
            INVITE_CODE_WORDS,
            RISK_PORTS,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            sms: SmsCodeService | null,
            tokens: TokenService,
            sensitiveWords: SensitiveWords,
            risk: IdentityRiskPorts | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): SmsLoginService | null =>
            db === undefined || fieldCrypto === undefined || reader === null || sms === null
              ? null
              : createSmsLoginService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  logger,
                  versions: reader,
                  sms,
                  // TODO(规划/11 §2.3): invite binding (bindInvite), B1-03g ports — blocked on B1-11, B1-03g
                  registration: createRegistrationService({
                    clock,
                    config: reader,
                    crypto: fieldCrypto,
                    logger,
                    sensitiveWords,
                    ...(risk === null ? {} : risk.registration),
                  }),
                  ...(risk === null ? {} : risk.login),
                  // Registration keys are snapshotted before the login transaction opens.
                  config: reader,
                  tokens,
                }),
        },
        {
          // The unbinding hook of a reuse revocation (afterRevoked) joins with B1-12b.
          provide: REFRESH,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            IDENTITY_CONFIG,
            TOKEN_SERVICE,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reader: IdentityConfigReader | null,
            tokens: TokenService,
            db?: Kysely<Database>,
            redis?: RedisHandle,
            fieldCrypto?: FieldCrypto,
          ): RefreshService | null =>
            db === undefined || redis === undefined || fieldCrypto === undefined || reader === null
              ? null
              : createRefreshService({
                  db,
                  clock,
                  tokens,
                  crypto: fieldCrypto,
                  redis,
                  versions: reader,
                  logger,
                }),
        },
        options.thirdPartyIdentity === undefined
          ? { provide: THIRD_PARTY_IDENTITY, useValue: null }
          : { ...options.thirdPartyIdentity, provide: THIRD_PARTY_IDENTITY },
        {
          provide: OAUTH_ATTEMPTS,
          inject: [
            CLOCK,
            IDENTITY_CONFIG,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            db?: Kysely<Database>,
            redis?: RedisHandle,
          ): OauthAttemptService | null =>
            db === undefined || redis === undefined || reader === null
              ? null
              : createOauthAttemptService({ db, redis, clock, config: reader }),
        },
        {
          provide: STEP_UP,
          inject: [
            CLOCK,
            IDENTITY_CONFIG,
            TOKEN_KEYS,
            SMS_CODES,
            OAUTH_ATTEMPTS,
            THIRD_PARTY_IDENTITY,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            keys: TokenKeyProvider,
            sms: SmsCodeService | null,
            attempts: OauthAttemptService | null,
            thirdPartyIdentity: ThirdPartyIdentityPort | null,
            db?: Kysely<Database>,
            fieldCrypto?: FieldCrypto,
          ): StepUpService | null =>
            db === undefined ||
            fieldCrypto === undefined ||
            reader === null ||
            sms === null ||
            attempts === null
              ? null
              : createStepUpService({
                  db,
                  clock,
                  crypto: fieldCrypto,
                  keys,
                  config: reader,
                  sms,
                  attempts,
                  ...(thirdPartyIdentity === null ? {} : { thirdPartyIdentity }),
                }),
        },
        {
          provide: H5_TOKENS,
          inject: [CLOCK, IDENTITY_CONFIG, TOKEN_KEYS, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            reader: IdentityConfigReader | null,
            keys: TokenKeyProvider,
            db?: Kysely<Database>,
          ): H5TokenService | null =>
            db === undefined || reader === null
              ? null
              : createH5TokenService({
                  clock,
                  keys,
                  sessions: createSessionLookup(db),
                  config: reader,
                }),
        },
        {
          provide: CONSENTS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): ConsentService | null =>
            db === undefined ? null : createConsentService({ db, clock }),
        },
        {
          provide: LOGOUT,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): Logout => createLogout({ db, clock }),
        },
      ],
      exports: [DEVICE_SIGNING_KEYS, TOKEN_CHECK],
    };
  }
}

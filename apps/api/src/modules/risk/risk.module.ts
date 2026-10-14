// Risk (规划/02 §4.1): request signatures (stage ① of BR-ID-01, BR-ID-09) and the minimum supported
// version / restricted session gate (stage ④a, B1-03c); rate limits, device risk, hard rules,
// blocklist, risk state and appeals follow. Risk depends on no business module: the device signing
// keys come through the DeviceSigningKeys port, which identity implements and app.module hands in
// as `imports` (orchestrator ruling B1-03b §9.3 #2); the minimum versions come through the
// MinimumVersionReader port, which content's reader implements and app.module supplies as a
// factory: a cached reader on the pool for the guard, and a reader factory over a handle for the
// idempotency post-miss hook, which reads on the claim's transaction (task B1-03c §9.3, §12).
// Stage ⑬ (rate limits, B1-03e) follows ④a on both paths: one global guard runs ④a then ⑬ for
// the non-idempotent operations, and the post-miss hook of ⑬ is registered after ④a's. Its
// thresholds come through the RateLimitThresholdReader port (content's configValue, assembled by
// app.module); its buckets need REDIS, and without REDIS stage ⑬ is not installed (one info line
// `rate_limit_disabled` at startup).
// Stage ⑤ (risk state, 10006, B1-03h) sits between ④a and ⑬ on both paths: the chained guard
// runs ④a, ⑤, ⑬, and ⑤'s post-miss hook is registered after ④a's and before ⑬'s. Its service
// (riskStateServiceToken(), the single writer of user_risk_state) needs DB and EVENT_BUS; without
// them stage ⑤ is not installed (one info line `risk_state_gate_disabled` at startup).
// Appeals (BR-ID-36, B1-03i): POST / GET /v1/me/appeals, always registered on the entry. Their
// service needs DB and stage ⑤'s service (the single writer of user_risk_state); the calendar is
// read through the configuration port over a handle (content's reader, assembled by app.module).
// Without them the service is not installed (one info line `appeals_disabled` at startup) and both
// routes answer 50001.
//
// Also compiled by the `test` project (through ./index.ts): a class decorator only (no parameter
// decorators or parameter properties; dependencies are injected through a factory), as in
// platform.module.ts.
import {
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type FactoryProvider,
  type NestInterceptor,
  type Provider,
  Module,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { map } from 'rxjs';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  IDEMPOTENCY,
  REDIS,
  ROOT_LOGGER,
  registerIdempotencyEntryObserver,
  registerIdempotencyPostMissCheck,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type Idempotency,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import {
  MINIMUM_VERSION_SCOPE,
  MinimumVersionUnjudgedError,
  createMinimumVersionCheck,
  createMinimumVersionEntryObserver,
  createMinimumVersionGuard,
  createMinimumVersionPostMissCheck,
  isIdempotentMinimumVersionRoute,
  type MinimumVersionCheck,
  type MinimumVersionReader,
  type MinimumVersionReaderOn,
  type MinimumVersionRequest,
  type MinimumVersionScope,
} from './application/minimum-version.ts';
import {
  createRateLimitGuard,
  createRateLimitPostMissCheck,
} from './application/rate-limit-gate.ts';
import {
  createRateLimitService,
  createRateLimitThresholdReader,
  type RateLimitService,
  type RateLimitThresholdReader,
  type RateLimitThresholdReaderOn,
} from './application/rate-limit.ts';
import {
  createRiskStateGuard,
  createRiskStatePostMissCheck,
} from './application/risk-state-gate.ts';
import {
  createRiskStateService,
  riskStateServiceToken,
  type RiskStateService,
} from './application/risk-state.ts';
import { createAppealsService, type AppealsService } from './application/appeals.ts';
import { APPEALS_SERVICE, AppealsController } from './http/public/appeals.controller.ts';
import {
  createSameDeviceAccountsCheck,
  sameDeviceAccountsCheckToken,
  sameDeviceLoginReaderToken,
  type SameDeviceAccountsCheck,
  type SameDeviceAccountsOptions,
  type SameDeviceLoginReader,
} from './application/same-device-accounts.ts';
import type { RateLimitConfigReader } from './application/rate-limit.ts';
import {
  DEVICE_SIGNING_KEYS,
  SIGNATURE_CHECK,
  createSignatureCheck,
  type DeviceSigningKeys,
} from './application/signature-check.ts';

/** Nest token of the stage ④a check (createMinimumVersionCheck over the reader below). */
export const MINIMUM_VERSION_CHECK = Symbol('MINIMUM_VERSION_CHECK');
const MINIMUM_VERSION_READER = Symbol('MINIMUM_VERSION_READER');
const MINIMUM_VERSION_HOOK = Symbol('MINIMUM_VERSION_HOOK');
/** Whether stage ④a is in force on this entry: true exactly when a reader is wired. */
const MINIMUM_VERSION_GATE = Symbol('MINIMUM_VERSION_GATE');
const RATE_LIMIT_THRESHOLDS = Symbol('RATE_LIMIT_THRESHOLDS');
/** Stage ⑤'s service, or null when it is not installed (no DB or EVENT_BUS on this entry). */
const RISK_STATE_SERVICE = riskStateServiceToken();
/** Stage ⑬'s service, or null when it is not installed (no REDIS on this entry). */
const RATE_LIMIT_SERVICE = Symbol('RATE_LIMIT_SERVICE');
/** BR-ID-37's check (B1-03k), or null when no login reader is wired. */
const SAME_DEVICE_ACCOUNTS_CHECK = sameDeviceAccountsCheckToken();
const SAME_DEVICE_LOGIN_READER = sameDeviceLoginReaderToken();
const SAME_DEVICE_CONFIG = Symbol('SAME_DEVICE_CONFIG');
const APPEALS_CONFIG = Symbol('APPEALS_CONFIG');

/** The minimum supported version port as app.module supplies it (content's reader). */
export interface MinimumVersionReaders {
  /** Cached reader on the pool: the guard (non-idempotent operations, outside any transaction). */
  readonly pooled: MinimumVersionReader;
  /**
   * A reader over a given handle: the post-miss hook builds one on the idempotency claim's
   * transaction per judgement, so it never borrows a second pooled connection while holding one.
   */
  readonly on: MinimumVersionReaderOn;
}

/** The rate limit thresholds port as app.module supplies it (content's configValue). */
export interface RateLimitThresholdReaders {
  /** Cached reader on the pool: the guard (non-idempotent operations, outside any transaction). */
  readonly pooled: RateLimitThresholdReader;
  /**
   * A reader over a given handle: the post-miss hook builds one on the idempotency claim's
   * transaction per judgement, so it never borrows a second pooled connection while holding one.
   */
  readonly on: RateLimitThresholdReaderOn;
}

export interface RiskModuleOptions {
  /** Modules that together export DEVICE_SIGNING_KEYS (the identity module). */
  readonly imports: NonNullable<DynamicModule['imports']>;
  /**
   * The minimum supported version port (content's reader), built by app.module. A factory that
   * returns null (no database handle; only tests and the contract smoke start the api entry that
   * way) or no factory at all: stage ④a is not installed on the entry (no guard, interceptor or
   * idempotency hook) and one info line `minimum_version_gate_disabled` is logged at startup
   * (orchestrator ruling B1-03c §13). A reader that is wired but fails still fails closed (50001).
   */
  readonly minimumVersions?: Pick<
    FactoryProvider<MinimumVersionReaders | null>,
    'inject' | 'useFactory'
  >;
  /**
   * Stage ⑬ (B1-03e): the thresholds port (content's configValue), built by app.module: a cached
   * pooled reader for the guard and a reader factory over the idempotency claim's transaction for
   * the post-miss hook (same split as minimumVersions). A factory that returns null, or none at
   * all, leaves the code defaults in force (no configuration read). Bucket keys use FIELD_CRYPTO's
   * blind index when the entry has a keyring.
   * The buckets need REDIS: without it stage ⑬ is not installed and one info line
   * `rate_limit_disabled` is logged at startup. A store that is wired but fails refuses (42901).
   */
  readonly rateLimit?: {
    readonly thresholds: Pick<
      FactoryProvider<RateLimitThresholdReaders | null>,
      'inject' | 'useFactory'
    >;
  };
  /**
   * BR-ID-37 同设备多账号 (B1-03k): identity's login reader and the configuration port bound to a
   * handle (content's reader over the caller's transaction), both assembled by app.module. Absent:
   * sameDeviceAccountsCheckToken() provides null.
   */
  readonly sameDevice?: {
    readonly logins: SameDeviceLoginReader;
    readonly config: Pick<
      FactoryProvider<(handle: Kysely<Database>) => RateLimitConfigReader>,
      'inject' | 'useFactory'
    >;
  };
  /**
   * Appeals (BR-ID-36, B1-03i): the configuration port bound to a handle (content's reader), for
   * the working-day calendar of the deadline, read on the submission's transaction. Absent: the
   * calendar reads nothing and counts weekends only.
   */
  readonly appeals?: {
    readonly config: Pick<
      FactoryProvider<(handle: Kysely<Database>) => RateLimitConfigReader>,
      'inject' | 'useFactory'
    >;
  };
}

/** No calendar configuration: every year counts weekends only. */
const NO_APPEALS_CONFIG = (): RateLimitConfigReader => DEFAULT_THRESHOLDS_CONFIG;

/** No configuration reader: the code defaults only. */
const DEFAULT_THRESHOLDS_CONFIG = { configValue: () => Promise.resolve(null) };

/** No reader: a judgement that needs the minimum fails (never read as "no minimum"). */
const UNAVAILABLE_READER: MinimumVersionReader = {
  minSupportedVersion: () =>
    Promise.reject(new Error('minimum supported version reader unavailable')),
};

/** Stage ④a not installed (no reader): the global guard slot lets every request through. */
const GATE_DISABLED_GUARD = { canActivate: () => true };

/** Neither stage needs the post-miss scope: the global interceptor slot hands the handler through. */
const GATE_DISABLED_INTERCEPTOR: NestInterceptor = {
  intercept: (_context: ExecutionContext, next: CallHandler) => next.handle(),
};

type ScopeReply = MinimumVersionScope['reply'];

/** The Fastify reply of the HTTP context, for headers set by a stage judged in the post-miss hook. */
function replyOf(http: { getResponse?: () => unknown }): ScopeReply {
  const reply = typeof http.getResponse === 'function' ? http.getResponse() : undefined;
  return typeof reply === 'object' &&
    reply !== null &&
    typeof (reply as { header?: unknown }).header === 'function'
    ? (reply as NonNullable<ScopeReply>)
    : undefined;
}

/**
 * Opens MINIMUM_VERSION_SCOPE around the route handler for the idempotency post-miss hook, and
 * fails closed (MinimumVersionUnjudgedError → 50001) when an idempotent operation's handler
 * succeeds although the IDEMPOTENCY instance never received the request. A replay, 40901 or
 * other refusal of the idempotency module counts as received (its entry observer ran).
 */
export const MINIMUM_VERSION_INTERCEPTOR: NestInterceptor = {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<MinimumVersionRequest>();
    const scope = { request, reply: replyOf(http), idempotencyEntered: false };
    const idempotent = isIdempotentMinimumVersionRoute(request);
    // Nest binds the handler to the async context in which handle() is called.
    return MINIMUM_VERSION_SCOPE.run(scope, () =>
      next.handle().pipe(
        map((value: unknown) => {
          if (idempotent && !scope.idempotencyEntered) {
            throw new MinimumVersionUnjudgedError(request.method, request.routeOptions.url);
          }
          return value;
        }),
      ),
    );
  },
};

/**
 * Stage ⑤ or ⑬ without stage ④a (no minimum version reader): opens MINIMUM_VERSION_SCOPE for
 * their post-miss hooks only, without ④a's fail-closed rule.
 */
const RATE_LIMIT_SCOPE_INTERCEPTOR: NestInterceptor = {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<MinimumVersionRequest>();
    const scope = { request, reply: replyOf(http), idempotencyEntered: false };
    return MINIMUM_VERSION_SCOPE.run(scope, () => next.handle());
  },
};

interface StageGuard {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

/** ④a, ⑤ then ⑬ in one global guard, so their order never depends on guard registration order. */
function chainGuards(first: StageGuard, ...rest: readonly (StageGuard | null)[]): StageGuard {
  const stages = [first, ...rest.filter((stage): stage is StageGuard => stage !== null)];
  if (stages.length === 1) return first;
  return {
    async canActivate(context: ExecutionContext) {
      for (const stage of stages) {
        if (!(await stage.canActivate(context))) return false;
      }
      return true;
    },
  };
}

@Module({})
export class RiskModule {
  /**
   * Provides SIGNATURE_CHECK, the stage ① request check that app.module places first in
   * REQUEST_CHECKS. Without a REDIS provider the check still refuses an invalid request with
   * 10401 / 10402, and fails a valid one closed (50001).
   * Installs stage ④a when a minimum version reader is wired: a global guard judging the
   * non-idempotent operations after ① ② ③, an interceptor carrying the HTTP request to the
   * handler's async context, and the post-miss check on the IDEMPOTENCY instance judging the
   * idempotent ones. Without a reader the guard and interceptor slots pass through, no hook is
   * registered, and an info line is logged once (B1-03c §13).
   */
  static forRoot(options: RiskModuleOptions): DynamicModule {
    const thresholds: FactoryProvider<RateLimitThresholdReaders | null> =
      options.rateLimit === undefined
        ? { provide: RATE_LIMIT_THRESHOLDS, useFactory: () => null }
        : { provide: RATE_LIMIT_THRESHOLDS, ...options.rateLimit.thresholds };
    const reader: FactoryProvider<MinimumVersionReaders | null> =
      options.minimumVersions === undefined
        ? { provide: MINIMUM_VERSION_READER, useFactory: () => null }
        : { provide: MINIMUM_VERSION_READER, ...options.minimumVersions };
    const sameDevice = options.sameDevice;
    const sameDeviceProviders: Provider[] =
      sameDevice === undefined
        ? [{ provide: SAME_DEVICE_ACCOUNTS_CHECK, useValue: null }]
        : [
            { provide: SAME_DEVICE_LOGIN_READER, useValue: sameDevice.logins },
            { provide: SAME_DEVICE_CONFIG, ...sameDevice.config },
            {
              provide: SAME_DEVICE_ACCOUNTS_CHECK,
              inject: [CLOCK, ROOT_LOGGER, SAME_DEVICE_LOGIN_READER, SAME_DEVICE_CONFIG],
              useFactory: (
                clock: Clock,
                logger: RootLogger,
                logins: SameDeviceLoginReader,
                config: SameDeviceAccountsOptions['config'],
              ): SameDeviceAccountsCheck =>
                createSameDeviceAccountsCheck({ clock, logger, logins, config }),
            },
          ];
    const appealsConfig: FactoryProvider<(handle: Kysely<Database>) => RateLimitConfigReader> =
      options.appeals === undefined
        ? { provide: APPEALS_CONFIG, useFactory: () => NO_APPEALS_CONFIG }
        : { provide: APPEALS_CONFIG, ...options.appeals.config };
    return {
      module: RiskModule,
      imports: [...options.imports],
      controllers: [AppealsController],
      providers: [
        ...sameDeviceProviders,
        appealsConfig,
        {
          provide: SIGNATURE_CHECK,
          inject: [DEVICE_SIGNING_KEYS, CLOCK, { token: REDIS, optional: true }],
          useFactory: (devices: DeviceSigningKeys, clock: Clock, redis?: RedisHandle) =>
            createSignatureCheck({ devices, clock, ...(redis === undefined ? {} : { redis }) }),
        },
        reader,
        {
          provide: MINIMUM_VERSION_CHECK,
          inject: [MINIMUM_VERSION_READER],
          useFactory: (versions: MinimumVersionReaders | null) =>
            createMinimumVersionCheck(versions?.pooled ?? UNAVAILABLE_READER),
        },
        {
          provide: MINIMUM_VERSION_GATE,
          inject: [MINIMUM_VERSION_READER, ROOT_LOGGER],
          useFactory: (versions: MinimumVersionReaders | null, logger: RootLogger) => {
            if (versions !== null) return true;
            // The root logger binds `entry` to every line.
            logger.info({ stage: '4a' }, 'minimum_version_gate_disabled');
            return false;
          },
        },
        thresholds,
        {
          provide: RATE_LIMIT_SERVICE,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            RATE_LIMIT_THRESHOLDS,
            { token: REDIS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            configured: RateLimitThresholdReaders | null,
            redis?: RedisHandle,
            crypto?: FieldCrypto,
          ): RateLimitService | null => {
            if (redis === undefined) {
              logger.info({ stage: '13' }, 'rate_limit_disabled');
              return null;
            }
            return createRateLimitService({
              clock,
              redis,
              logger,
              thresholds:
                configured?.pooled ?? createRateLimitThresholdReader(DEFAULT_THRESHOLDS_CONFIG),
              ...(crypto === undefined ? {} : { crypto }),
            });
          },
        },
        {
          // Stage ⑤'s service: the single writer of user_risk_state and its (cached) reader.
          provide: RISK_STATE_SERVICE,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            events?: EventBus,
          ): RiskStateService | null => {
            if (db === undefined || events === undefined) {
              logger.info({ stage: '5' }, 'risk_state_gate_disabled');
              return null;
            }
            return createRiskStateService({ db, clock, events });
          },
        },
        {
          // Appeals: the riskState service is the same instance the guard and hooks use.
          provide: APPEALS_SERVICE,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            RISK_STATE_SERVICE,
            APPEALS_CONFIG,
            { token: DB, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            riskState: RiskStateService | null,
            configOn: (handle: Kysely<Database>) => RateLimitConfigReader,
            db?: Kysely<Database>,
          ): AppealsService | null => {
            if (db === undefined || riskState === null) {
              logger.info({ route: '/v1/me/appeals' }, 'appeals_disabled');
              return null;
            }
            return createAppealsService({
              db,
              clock,
              riskState,
              logger,
              config: configOn(db),
              configOn,
            });
          },
        },
        {
          provide: APP_GUARD,
          inject: [
            MINIMUM_VERSION_CHECK,
            MINIMUM_VERSION_GATE,
            RISK_STATE_SERVICE,
            RATE_LIMIT_SERVICE,
          ],
          useFactory: (
            check: MinimumVersionCheck,
            enabled: boolean,
            riskState: RiskStateService | null,
            rateLimit: RateLimitService | null,
          ): StageGuard =>
            chainGuards(
              enabled ? createMinimumVersionGuard(check) : GATE_DISABLED_GUARD,
              riskState === null ? null : createRiskStateGuard(riskState),
              rateLimit === null ? null : createRateLimitGuard(rateLimit),
            ),
        },
        {
          provide: APP_INTERCEPTOR,
          inject: [MINIMUM_VERSION_GATE, RISK_STATE_SERVICE, RATE_LIMIT_SERVICE],
          useFactory: (
            enabled: boolean,
            riskState: RiskStateService | null,
            rateLimit: RateLimitService | null,
          ) =>
            enabled
              ? MINIMUM_VERSION_INTERCEPTOR
              : rateLimit === null && riskState === null
                ? GATE_DISABLED_INTERCEPTOR
                : RATE_LIMIT_SCOPE_INTERCEPTOR,
        },
        {
          // ④a's hook first, then ⑤'s, then ⑬'s: registration order is the judgement order.
          provide: MINIMUM_VERSION_HOOK,
          inject: [
            MINIMUM_VERSION_CHECK,
            MINIMUM_VERSION_READER,
            MINIMUM_VERSION_GATE,
            RISK_STATE_SERVICE,
            RATE_LIMIT_SERVICE,
            RATE_LIMIT_THRESHOLDS,
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            check: MinimumVersionCheck,
            versions: MinimumVersionReaders | null,
            enabled: boolean,
            riskState: RiskStateService | null,
            rateLimit: RateLimitService | null,
            limits: RateLimitThresholdReaders | null,
            idempotency?: Idempotency,
          ) => {
            if (enabled && idempotency !== undefined) {
              registerIdempotencyPostMissCheck(
                idempotency,
                createMinimumVersionPostMissCheck(check, versions?.on),
              );
              registerIdempotencyEntryObserver(idempotency, createMinimumVersionEntryObserver());
            }
            if (riskState !== null && idempotency !== undefined) {
              registerIdempotencyPostMissCheck(
                idempotency,
                createRiskStatePostMissCheck(riskState),
              );
            }
            if (rateLimit !== null && idempotency !== undefined) {
              registerIdempotencyPostMissCheck(
                idempotency,
                createRateLimitPostMissCheck(rateLimit, limits?.on),
              );
            }
            return true;
          },
        },
      ],
      exports: [
        SIGNATURE_CHECK,
        MINIMUM_VERSION_CHECK,
        RISK_STATE_SERVICE,
        SAME_DEVICE_ACCOUNTS_CHECK,
      ],
    };
  }
}

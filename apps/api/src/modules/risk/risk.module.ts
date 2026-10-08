// Risk (规划/02 §4.1): request signatures (stage ① of BR-ID-01, BR-ID-09) and the minimum supported
// version / restricted session gate (stage ④a, B1-03c); rate limits, device risk, hard rules,
// blocklist, risk state and appeals follow. Risk depends on no business module: the device signing
// keys come through the DeviceSigningKeys port, which identity implements and app.module hands in
// as `imports` (orchestrator ruling B1-03b §9.3 #2); the minimum versions come through the
// MinimumVersionReader port, which content's reader implements and app.module supplies as a
// factory: a cached reader on the pool for the guard, and a reader factory over a handle for the
// idempotency post-miss hook, which reads on the claim's transaction (task B1-03c §9.3, §12).
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
  Module,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { map } from 'rxjs';
import {
  CLOCK,
  IDEMPOTENCY,
  REDIS,
  ROOT_LOGGER,
  registerIdempotencyEntryObserver,
  registerIdempotencyPostMissCheck,
  type Clock,
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
} from './application/minimum-version.ts';
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
}

/** No reader: a judgement that needs the minimum fails (never read as "no minimum"). */
const UNAVAILABLE_READER: MinimumVersionReader = {
  minSupportedVersion: () =>
    Promise.reject(new Error('minimum supported version reader unavailable')),
};

/** Stage ④a not installed (no reader): the global guard slot lets every request through. */
const GATE_DISABLED_GUARD = { canActivate: () => true };

/** Stage ④a not installed (no reader): the global interceptor slot hands the handler through. */
const GATE_DISABLED_INTERCEPTOR: NestInterceptor = {
  intercept: (_context: ExecutionContext, next: CallHandler) => next.handle(),
};

/**
 * Opens MINIMUM_VERSION_SCOPE around the route handler for the idempotency post-miss hook, and
 * fails closed (MinimumVersionUnjudgedError → 50001) when an idempotent operation's handler
 * succeeds although the IDEMPOTENCY instance never received the request. A replay, 40901 or
 * other refusal of the idempotency module counts as received (its entry observer ran).
 */
export const MINIMUM_VERSION_INTERCEPTOR: NestInterceptor = {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<MinimumVersionRequest>();
    const scope = { request, idempotencyEntered: false };
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
    const reader: FactoryProvider<MinimumVersionReaders | null> =
      options.minimumVersions === undefined
        ? { provide: MINIMUM_VERSION_READER, useFactory: () => null }
        : { provide: MINIMUM_VERSION_READER, ...options.minimumVersions };
    return {
      module: RiskModule,
      imports: [...options.imports],
      providers: [
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
        {
          provide: APP_GUARD,
          inject: [MINIMUM_VERSION_CHECK, MINIMUM_VERSION_GATE],
          useFactory: (check: MinimumVersionCheck, enabled: boolean) =>
            enabled ? createMinimumVersionGuard(check) : GATE_DISABLED_GUARD,
        },
        {
          provide: APP_INTERCEPTOR,
          inject: [MINIMUM_VERSION_GATE],
          useFactory: (enabled: boolean) =>
            enabled ? MINIMUM_VERSION_INTERCEPTOR : GATE_DISABLED_INTERCEPTOR,
        },
        {
          provide: MINIMUM_VERSION_HOOK,
          inject: [
            MINIMUM_VERSION_CHECK,
            MINIMUM_VERSION_READER,
            MINIMUM_VERSION_GATE,
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            check: MinimumVersionCheck,
            versions: MinimumVersionReaders | null,
            enabled: boolean,
            idempotency?: Idempotency,
          ) => {
            if (enabled && idempotency !== undefined) {
              registerIdempotencyPostMissCheck(
                idempotency,
                createMinimumVersionPostMissCheck(check, versions?.on),
              );
              registerIdempotencyEntryObserver(idempotency, createMinimumVersionEntryObserver());
            }
            return true;
          },
        },
      ],
      exports: [SIGNATURE_CHECK, MINIMUM_VERSION_CHECK],
    };
  }
}

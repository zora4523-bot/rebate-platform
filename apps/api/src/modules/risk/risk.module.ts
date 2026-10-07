// Risk (规划/02 §4.1): request signatures (stage ① of BR-ID-01, BR-ID-09) and the minimum supported
// version / restricted session gate (stage ④a, B1-03c); rate limits, device risk, hard rules,
// blocklist, risk state and appeals follow. Risk depends on no business module: the device signing
// keys come through the DeviceSigningKeys port, which identity implements and app.module hands in
// as `imports` (orchestrator ruling B1-03b §9.3 #2); the minimum versions come through the
// MinimumVersionReader port, which content's reader implements and app.module supplies as a
// factory (task B1-03c §9.3).
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
import {
  CLOCK,
  IDEMPOTENCY,
  REDIS,
  registerIdempotencyPostMissCheck,
  type Clock,
  type Idempotency,
  type RedisHandle,
} from '../platform/index.ts';
import {
  MINIMUM_VERSION_SCOPE,
  createMinimumVersionCheck,
  createMinimumVersionGuard,
  createMinimumVersionPostMissCheck,
  type MinimumVersionCheck,
  type MinimumVersionReader,
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

export interface RiskModuleOptions {
  /** Modules that together export DEVICE_SIGNING_KEYS (the identity module). */
  readonly imports: NonNullable<DynamicModule['imports']>;
  /**
   * The minimum supported version port (content's reader), built by app.module. A factory that
   * returns null (no database handle) or no factory at all: every judged read fails closed (50001).
   */
  readonly minimumVersions?: Pick<
    FactoryProvider<MinimumVersionReader | null>,
    'inject' | 'useFactory'
  >;
}

/** No reader: a judgement that needs the minimum fails (never read as "no minimum"). */
const UNAVAILABLE_READER: MinimumVersionReader = {
  minSupportedVersion: () =>
    Promise.reject(new Error('minimum supported version reader unavailable')),
};

/** Opens MINIMUM_VERSION_SCOPE around the route handler for the idempotency post-miss hook. */
const MINIMUM_VERSION_INTERCEPTOR: NestInterceptor = {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<MinimumVersionRequest>();
    // Nest binds the handler to the async context in which handle() is called.
    return MINIMUM_VERSION_SCOPE.run(request, () => next.handle());
  },
};

@Module({})
export class RiskModule {
  /**
   * Provides SIGNATURE_CHECK, the stage ① request check that app.module places first in
   * REQUEST_CHECKS. Without a REDIS provider the check still refuses an invalid request with
   * 10401 / 10402, and fails a valid one closed (50001).
   * Installs stage ④a: a global guard judging the non-idempotent operations after ① ② ③, an
   * interceptor carrying the HTTP request to the handler's async context, and the post-miss check
   * on the IDEMPOTENCY instance (when there is a database) judging the idempotent ones.
   */
  static forRoot(options: RiskModuleOptions): DynamicModule {
    const reader: FactoryProvider<MinimumVersionReader | null> =
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
          useFactory: (versions: MinimumVersionReader | null) =>
            createMinimumVersionCheck(versions ?? UNAVAILABLE_READER),
        },
        {
          provide: APP_GUARD,
          inject: [MINIMUM_VERSION_CHECK],
          useFactory: (check: MinimumVersionCheck) => createMinimumVersionGuard(check),
        },
        { provide: APP_INTERCEPTOR, useValue: MINIMUM_VERSION_INTERCEPTOR },
        {
          provide: MINIMUM_VERSION_HOOK,
          inject: [MINIMUM_VERSION_CHECK, { token: IDEMPOTENCY, optional: true }],
          useFactory: (check: MinimumVersionCheck, idempotency?: Idempotency) => {
            if (idempotency !== undefined) {
              registerIdempotencyPostMissCheck(
                idempotency,
                createMinimumVersionPostMissCheck(check),
              );
            }
            return true;
          },
        },
      ],
      exports: [SIGNATURE_CHECK, MINIMUM_VERSION_CHECK],
    };
  }
}

// Risk (规划/02 §4.1): request signatures today (stage ① of BR-ID-01, BR-ID-09); rate limits,
// device risk, hard rules, blocklist, risk state and appeals follow. Risk depends on no business
// module: the device signing keys come through the DeviceSigningKeys port, which identity
// implements and app.module hands in as `imports` (orchestrator ruling B1-03b §9.3 #2).
//
// Also compiled by the `test` project (through ./index.ts): a class decorator only (no parameter
// decorators or parameter properties; dependencies are injected through a factory), as in
// platform.module.ts.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, REDIS, type Clock, type RedisHandle } from '../platform/index.ts';
import {
  DEVICE_SIGNING_KEYS,
  SIGNATURE_CHECK,
  createSignatureCheck,
  type DeviceSigningKeys,
} from './application/signature-check.ts';

export interface RiskModuleOptions {
  /** Modules that together export DEVICE_SIGNING_KEYS (the identity module). */
  readonly imports: NonNullable<DynamicModule['imports']>;
}

@Module({})
export class RiskModule {
  /**
   * Provides SIGNATURE_CHECK, the stage ① request check that app.module places first in
   * REQUEST_CHECKS. Without a REDIS provider the check still refuses an invalid request with
   * 10401 / 10402, and fails a valid one closed (50001).
   */
  static forRoot(options: RiskModuleOptions): DynamicModule {
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
      ],
      exports: [SIGNATURE_CHECK],
    };
  }
}

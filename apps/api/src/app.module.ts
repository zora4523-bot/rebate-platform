import { type DynamicModule, type Provider, Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/index.ts';
import { HealthModule } from './modules/health/index.ts';
import { IdentityModule } from './modules/identity/index.ts';
import {
  PlatformModule,
  type PlatformOptions,
  REQUEST_CHECKS,
  type RequestCheck,
  isHttpEntry,
} from './modules/platform/index.ts';
import { RiskModule, SIGNATURE_CHECK } from './modules/risk/index.ts';

/**
 * The ordered request checks bootstrap installs before Fastify parses a body (规划/08 BR-ID-01):
 * ① the request signature on the `api` entry, which serves every x-signed operation; the token
 * stages ② ③ (B1-02h) follow it in this list. The other HTTP entries have none yet.
 */
function requestChecks(options: PlatformOptions): Provider {
  return options.entry === 'api'
    ? {
        provide: REQUEST_CHECKS,
        inject: [SIGNATURE_CHECK],
        useFactory: (signature: RequestCheck): readonly RequestCheck[] => [signature],
      }
    : { provide: REQUEST_CHECKS, useValue: [] };
}

/**
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes and the risk module's request signature check, whose
 * device port identity implements; the worker entries load only the platform module.
 * The admin module provides the platform audit port on every entry (F1-06b).
 * Business modules are added to the entries that own them by their tasks (规划/02 §4.1).
 */
@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        // Provides the platform AUDIT_PORT globally on every entry (F1-06b).
        AdminModule,
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        ...(options.entry === 'api'
          ? [IdentityModule, RiskModule.forRoot({ imports: [IdentityModule] })]
          : []),
      ],
      providers: isHttpEntry(options.entry) ? [requestChecks(options)] : [],
    };
  }
}

import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './modules/health/index.ts';
import { IdentityModule } from './modules/identity/index.ts';
import { PlatformModule, type PlatformOptions, isHttpEntry } from './modules/platform/index.ts';

/**
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes; the worker entries load only the platform module.
 * Business modules are added to the entries that own them by their tasks (规划/02 §4.1).
 */
@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        ...(options.entry === 'api' ? [IdentityModule] : []),
      ],
    };
  }
}

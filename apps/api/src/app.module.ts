import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './modules/health/index.ts';
import { PlatformModule, type PlatformOptions, isHttpEntry } from './modules/platform/index.ts';

/**
 * Root module, assembled per process entry. Today every HTTP entry serves only the health
 * probe and the worker entries load only the platform module; business modules are added to
 * the entries that own them by their tasks (规划/02 §4.1).
 */
@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
      ],
    };
  }
}

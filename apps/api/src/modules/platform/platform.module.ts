import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from './clock/index.ts';
import type { AppConfig } from './config/index.ts';
import type { EntryName } from './entries.ts';
import type { RootLogger } from './logging/index.ts';

/** Nest injection tokens provided by `PlatformModule`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const APP_ENTRY = Symbol('APP_ENTRY');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');

export interface PlatformOptions {
  readonly entry: EntryName;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

/**
 * Cross-cutting infrastructure shared by every module: configuration, clock, logger.
 * TODO(ADR-0001 §4.2 #15): JobQueue, idempotency, request validation and database handles are provided here — blocked on B1-01.
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: APP_ENTRY, useValue: options.entry },
        { provide: CLOCK, useValue: options.clock },
        { provide: ROOT_LOGGER, useValue: options.logger },
      ],
      exports: [APP_CONFIG, APP_ENTRY, CLOCK, ROOT_LOGGER],
    };
  }
}

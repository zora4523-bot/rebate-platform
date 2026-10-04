import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from './clock/index.ts';
import type { AppConfig } from './config/index.ts';
import { openConfiguredFieldCrypto } from './config/keyring-startup.ts';
import type { DbHandles } from './db/index.ts';
import type { EntryName } from './entries.ts';
import { createIdempotency } from './idempotency/index.ts';
import type { RootLogger } from './logging/index.ts';

/** Nest injection tokens provided by `PlatformModule`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const APP_ENTRY = Symbol('APP_ENTRY');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
export const DB = Symbol('DB');
export const DB_READ = Symbol('DB_READ');
export const IDEMPOTENCY = Symbol('IDEMPOTENCY');
export const FIELD_CRYPTO = Symbol('FIELD_CRYPTO');
const DB_LIFECYCLE = Symbol('DB_LIFECYCLE');

export interface PlatformOptions {
  readonly entry: EntryName;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Supplied by the process runner; may be omitted by isolated HTTP unit tests. */
  readonly dbHandles?: DbHandles;
}

/**
 * Cross-cutting infrastructure shared by every module: configuration, clock, logger.
 * TODO(规划/11 §2): provide JobQueue — blocked on B1-01.
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const handles = options.dbHandles;
    const keyring = options.config.keyring;
    const cryptoProviders =
      keyring === null
        ? []
        : [
            {
              provide: FIELD_CRYPTO,
              useFactory: async () =>
                await openConfiguredFieldCrypto(options.config.appEnv, keyring),
            },
          ];
    const databaseProviders =
      handles === undefined
        ? []
        : [
            { provide: DB, useValue: handles.db },
            {
              provide: IDEMPOTENCY,
              useFactory: () =>
                createIdempotency({
                  db: handles.db,
                  clock: options.clock,
                  logger: options.logger,
                }),
            },
            ...(options.entry === 'admin' && handles.dbRead !== null
              ? [{ provide: DB_READ, useValue: handles.dbRead }]
              : []),
            {
              provide: DB_LIFECYCLE,
              // Nest disposes the HTTP server before this hook. Earlier hooks would close the
              // database while HTTP requests were still running.
              useValue: { onApplicationShutdown: () => handles.close() },
            },
          ];
    return {
      module: PlatformModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: APP_ENTRY, useValue: options.entry },
        { provide: CLOCK, useValue: options.clock },
        { provide: ROOT_LOGGER, useValue: options.logger },
        ...databaseProviders,
        ...cryptoProviders,
      ],
      exports: [
        APP_CONFIG,
        APP_ENTRY,
        CLOCK,
        ROOT_LOGGER,
        ...(keyring === null ? [] : [FIELD_CRYPTO]),
        ...(handles === undefined ? [] : [DB, IDEMPOTENCY]),
        ...(handles !== undefined && options.entry === 'admin' && handles.dbRead !== null
          ? [DB_READ]
          : []),
      ],
    };
  }
}

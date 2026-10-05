import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from './clock/index.ts';
import type { AppConfig } from './config/index.ts';
import { openConfiguredFieldCrypto } from './config/keyring-startup.ts';
import type { ConnectionConfig, DbHandles } from './db/index.ts';
import type { EntryName } from './entries.ts';
import { createEventBus } from './events/index.ts';
import { createIdempotency } from './idempotency/index.ts';
import type { RootLogger } from './logging/index.ts';
import { createQueueRuntime, type JobQueue } from './queue/index.ts';
import { createRedisHandle } from './redis/index.ts';

/** Nest injection tokens provided by `PlatformModule`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const APP_ENTRY = Symbol('APP_ENTRY');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
export const DB = Symbol('DB');
export const DB_READ = Symbol('DB_READ');
export const IDEMPOTENCY = Symbol('IDEMPOTENCY');
export const FIELD_CRYPTO = Symbol('FIELD_CRYPTO');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const EVENT_BUS = Symbol('EVENT_BUS');
export const REDIS = Symbol('REDIS');
const DB_LIFECYCLE = Symbol('DB_LIFECYCLE');

export interface PlatformOptions {
  readonly entry: EntryName;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Supplied by the process runner; may be omitted by isolated HTTP unit tests. */
  readonly dbHandles?: DbHandles;
  /**
   * REDIS_URL of the entry (`ConnectionConfig.redisUrl`): provides `REDIS`. Null (payout) or
   * omitted (isolated HTTP unit tests): no `REDIS` provider.
   */
  readonly redisUrl?: ConnectionConfig['redisUrl'];
}

/**
 * Cross-cutting infrastructure shared by every module: configuration, clock, logger.
 * The process runner starts the queue after module handlers have registered, before serving traffic.
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
    const queue =
      handles === undefined
        ? undefined
        : createQueueRuntime({
            entry: options.entry,
            db: handles.db,
            logger: options.logger,
          });
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
            { provide: JOB_QUEUE, useValue: queue },
            {
              provide: EVENT_BUS,
              inject: [JOB_QUEUE, CLOCK],
              useFactory: (jobQueue: JobQueue, clock: Clock) =>
                createEventBus({ queue: jobQueue, clock }),
            },
            ...(options.entry === 'admin' && handles.dbRead !== null
              ? [{ provide: DB_READ, useValue: handles.dbRead }]
              : []),
            {
              provide: DB_LIFECYCLE,
              // Nest disposes the HTTP server before this hook. Earlier hooks would close the
              // database while HTTP requests were still running.
              useValue: {
                onApplicationShutdown: async () => {
                  await queue?.stop();
                  await handles.close();
                },
              },
            },
          ];
    const redisUrl = options.redisUrl ?? null;
    const redisProviders =
      redisUrl === null
        ? []
        : [
            {
              provide: REDIS,
              // Lazy handle: building it opens no connection, so entries start while Redis is
              // unreachable. Nest calls the handle's own onApplicationShutdown on close (after
              // HTTP entries stopped serving).
              useFactory: async () => {
                const handle = await createRedisHandle(
                  { entry: options.entry, redisUrl },
                  { logger: options.logger },
                );
                if (handle === null) throw new Error('Redis handle missing for a REDIS_URL');
                return handle;
              },
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
        ...redisProviders,
        ...cryptoProviders,
      ],
      exports: [
        APP_CONFIG,
        APP_ENTRY,
        CLOCK,
        ROOT_LOGGER,
        ...(keyring === null ? [] : [FIELD_CRYPTO]),
        ...(redisUrl === null ? [] : [REDIS]),
        ...(handles === undefined ? [] : [DB, IDEMPOTENCY, JOB_QUEUE, EVENT_BUS]),
        ...(handles !== undefined && options.entry === 'admin' && handles.dbRead !== null
          ? [DB_READ]
          : []),
      ],
    };
  }
}

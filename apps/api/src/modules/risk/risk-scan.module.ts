// Risk scans of the worker entry (BR-ID-36, B1-03j): app.module imports this module on `worker`
// only. It builds the risk state service (the single writer of user_risk_state) over DB and
// EVENT_BUS (and REDIS for its version stamp when the entry has one), the scan over it, and registers the scan's handler on JOB_QUEUE for queue
// `risk-scan` (in the worker's ENTRY_PLAN only). Seeding the chain is entry.ts's job, after the
// queue runtime started (seedRiskScan with riskScanToken()). Without a database handle nothing
// is registered, riskScanToken() provides null and one info line `risk_scan_disabled` is logged.
// It also provides redisGenerationRenewalToken() (R-04, B1-02zi): the generation key's renewal
// under APP_ENV staging / prod (armed by entry.ts) with REDIS, else null; entry.ts starts it.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EVENT_BUS,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import {
  RISK_SCAN_QUEUE,
  createRiskScan,
  riskScanToken,
  type RiskScan,
} from './application/risk-scan.ts';
import { createRiskStateService } from './application/risk-state.ts';
import {
  createRedisGenerationRenewal,
  isRedisGenerationArmed,
  isRedisGenerationEnabled,
  redisGenerationRenewalToken,
  type RedisGenerationRenewal,
} from './application/redis-generation.ts';

@Module({})
export class RiskScanModule {
  static forWorker(): DynamicModule {
    return {
      module: RiskScanModule,
      providers: [
        {
          provide: riskScanToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            events?: EventBus,
            queue?: QueueRuntime,
            redis?: RedisHandle,
          ): RiskScan | null => {
            if (db === undefined || events === undefined || queue === undefined) {
              logger.info({ queue: RISK_SCAN_QUEUE }, 'risk_scan_disabled');
              return null;
            }
            // REDIS: an expired freeze's change raises the version stamp (F1-07d) like any other.
            const riskState = createRiskStateService({
              db,
              clock,
              events,
              ...(redis === undefined ? {} : { redis }),
            });
            const scan = createRiskScan({ db, clock, riskState, queue, logger });
            queue.register(RISK_SCAN_QUEUE, (job) => scan.handle(job));
            return scan;
          },
        },
        {
          // R-04 (B1-02zi): the generation key's renewal, started by entry.ts every 60 seconds.
          // APP_ENV staging / prod only; without REDIS there is nothing to renew (one info line).
          provide: redisGenerationRenewalToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: APP_CONFIG, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config?: Pick<AppConfig, 'appEnv'>,
            redis?: RedisHandle,
          ): RedisGenerationRenewal | null => {
            if (
              !isRedisGenerationArmed() ||
              config === undefined ||
              !isRedisGenerationEnabled(config.appEnv)
            ) {
              return null;
            }
            if (redis === undefined) {
              logger.info('redis_generation_renewal_disabled');
              return null;
            }
            return createRedisGenerationRenewal({ redis, clock, logger });
          },
        },
      ],
      exports: [riskScanToken(), redisGenerationRenewalToken()],
    };
  }
}

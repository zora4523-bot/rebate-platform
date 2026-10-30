// Risk scans of the worker entry (BR-ID-36, B1-03j): app.module imports this module on `worker`
// only. It builds the risk state service (the single writer of user_risk_state) over DB and
// EVENT_BUS (and REDIS for its version stamp when the entry has one), the scan over it, and registers the scan's handler on JOB_QUEUE for queue
// `risk-scan` (in the worker's ENTRY_PLAN only). Seeding the chain is entry.ts's job, after the
// queue runtime started (seedRiskScan with riskScanToken()). Without a database handle nothing
// is registered, riskScanToken() provides null and one info line `risk_scan_disabled` is logged.
// It also provides redisGenerationRenewalToken() (R-04, B1-02zi): the generation key's renewal
// under APP_ENV staging / prod (armed by entry.ts) with REDIS, else null; entry.ts starts it.
// B1-03z: it also registers the appeal.resolved consumer `risk-appeal-restore` (appeal_restore
// differences of revoked ban appeals, BR-FUND-22 / BR-CALC-13 细则「申诉恢复」) on queue
// `evt.risk-appeal-restore` through registerEventConsumer, as notification-appeal-result does.
// commission's ports come from app.module (ports.appealRestoreShares / appealRestoreRunStart, and
// ledger's forfeited amount once ledger exports it; dependency inversion: commission's index.ts
// reaches risk's through identity / growth). Registration runs no statement;
// without a database handle or queue nothing is registered and one info line
// `appeal_restore_disabled` is logged.
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
  registerEventConsumer,
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
  createAppealRestoreHandler,
  type AppealRestoreConsumer,
  type BannedForfeitedSharesPort,
  type BannedRunStartPort,
  type ForfeitedAmountPort,
} from './application/appeal-restore.ts';
import {
  createRedisGenerationRenewal,
  isRedisGenerationArmed,
  isRedisGenerationEnabled,
  redisGenerationRenewalToken,
  type RedisGenerationRenewal,
} from './application/redis-generation.ts';

/** Nest token of the worker's registration of the appeal restore consumer (B1-03z). */
export const APPEAL_RESTORE_CONSUMER_TOKEN = Symbol('APPEAL_RESTORE_CONSUMER');

const APPEAL_RESTORE_CONSUMER: AppealRestoreConsumer = 'risk-appeal-restore';

export interface RiskScanWorkerPorts {
  /** B1-03z: commission's listBannedForfeitedShares, assembled by app.module. */
  readonly appealRestoreShares: BannedForfeitedSharesPort;
  /** B1-03z r2: commission's findBannedRunStart (appeals without penalty_started_at). */
  readonly appealRestoreRunStart: BannedRunStartPort;
  /**
   * B1-03z r2: the FORFEIT voucher amount (a ledger read). Absent until ledger exports it: a
   * revoked ban appeal with shares then rejects (appeal_restore_amount_unavailable).
   */
  readonly appealRestoreForfeitedAmount?: ForfeitedAmountPort;
}

@Module({})
export class RiskScanModule {
  static forWorker(ports: RiskScanWorkerPorts): DynamicModule {
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
        {
          provide: APPEAL_RESTORE_CONSUMER_TOKEN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
          ): boolean => {
            if (db === undefined || queue === undefined) {
              logger.info({ consumer: APPEAL_RESTORE_CONSUMER }, 'appeal_restore_disabled');
              return false;
            }
            registerEventConsumer(queue, {
              consumer: APPEAL_RESTORE_CONSUMER,
              db,
              logger,
              handler: createAppealRestoreHandler({
                clock,
                shares: ports.appealRestoreShares,
                bannedRunStart: ports.appealRestoreRunStart,
                ...(ports.appealRestoreForfeitedAmount === undefined
                  ? {}
                  : { forfeitedAmount: ports.appealRestoreForfeitedAmount }),
                logger: logger.child({ consumer: APPEAL_RESTORE_CONSUMER }),
              }),
            });
            return true;
          },
        },
      ],
      exports: [riskScanToken(), redisGenerationRenewalToken()],
    };
  }
}

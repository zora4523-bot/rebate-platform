// B2-05c / B2-05d: the payout module on the api entry. app.module assembles the ports of the
// withdrawal rules use case (identity, risk, ledger, content's configuration reader, the default
// fee / tax calculator and the "nothing pending" re-verification gate) and hands them as `rules`,
// and the application use case (the same ports plus identity's users lock and payee snapshot,
// the ledger and the event bus) as `apply`; an entry without a database (contract smoke, tests)
// gets no use case and the controller refuses with 50001. `handle` overrides the process DB
// handle (tests only).
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { BALANCE_RECOVERED_HOOK, createLedger } from '../ledger/index.ts';
import { createBalanceRecoveredHook } from './application/balance-recovered.ts';
import {
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  JOB_QUEUE,
  ROOT_LOGGER,
  registerEventConsumer,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type ReceivedJob,
  type RootLogger,
} from '../platform/index.ts';
import { WENT_NEGATIVE_CONSUMER, createWentNegativeConsumer } from './application/went-negative.ts';
import { PAYOUT_LANDING_QUEUE, createLandingJob } from './jobs/landing-job.ts';
import type { WithdrawalAttemptsPort } from './application/withdrawal-commands.ts';
import type { WithdrawApplyOptions, WithdrawApplyService } from './application/withdraw-apply.ts';
import {
  registerWithdrawalAccountDecrypt,
  type DecryptWithdrawalAccount,
} from './application/withdrawal-reads.ts';
import type { WithdrawRulesService } from './application/withdraw-rules.ts';
import {
  WithdrawalsController,
  type WithdrawStepUp,
} from './http/public/withdrawals.controller.ts';
import {
  WITHDRAW_APPLY,
  WITHDRAW_RULES,
  WITHDRAW_READS,
  WITHDRAW_RULES_HANDLE,
  WITHDRAW_STEP_UP,
} from './tokens.ts';

type Factory<T> = Pick<FactoryProvider<T | null>, 'inject' | 'useFactory'>;

export interface PayoutModuleOptions {
  /** A ready use case (tests), or a factory over the entry's providers (app.module). */
  rules?: WithdrawRulesService | Factory<WithdrawRulesService>;
  apply?: WithdrawApplyService | Factory<WithdrawApplyService>;
  /** identity's withStepUp (app.module); without it POST /v1/withdrawals refuses with 50001. */
  stepUp?: WithdrawStepUp;
  /**
   * B2-05f: the process's snapshot decryption for the records (a factory over the entry's field
   * cipher, app.module); registered once for read.ts and used by the two GET handlers.
   */
  reads?: Factory<DecryptWithdrawalAccount>;
  handle?: Kysely<DB>;
}

function provider<T>(
  token: symbol,
  value: T | Factory<T> | undefined,
  isService: (value: T | Factory<T>) => value is T,
) {
  return value === undefined
    ? { provide: token, useValue: null }
    : isService(value)
      ? { provide: token, useValue: value }
      : { provide: token, ...value };
}

function isRulesService(
  value: WithdrawRulesService | Factory<WithdrawRulesService>,
): value is WithdrawRulesService {
  return typeof (value as WithdrawRulesService).getRules === 'function';
}

function isApplyService(
  value: WithdrawApplyService | Factory<WithdrawApplyService>,
): value is WithdrawApplyService {
  return typeof (value as WithdrawApplyService).apply === 'function';
}

/** The negative balance consumer's registration token (worker entry). */
export const WENT_NEGATIVE_CONSUMER_TOKEN = Symbol('PAYOUT_WENT_NEGATIVE_CONSUMER');

export interface PayoutWorkerOptions {
  /** identity's users row lock (dependency inversion: app.module hands it in). */
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  /** payout_attempts reads; until B2-06 app.module hands in a port that reports none. */
  attempts: WithdrawalAttemptsPort;
}

/**
 * A direct negative-balance recheck job (payout's transfer job, W9 member_blocked: payload exactly
 * { app_id, user_id }) wrapped as the event envelope registerEventConsumer requires; an event the
 * bus published already carries the envelope and passes through unchanged.
 */
function withEnvelope(job: ReceivedJob, clock: Clock): ReceivedJob {
  const payload = job.payload as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'app_id' ||
    keys[1] !== 'user_id' ||
    typeof payload['app_id'] !== 'string' ||
    typeof payload['user_id'] !== 'string'
  ) {
    return job;
  }
  return {
    ...job,
    payload: {
      app_id: payload['app_id'],
      v: 1,
      occurred_at: clock.now().toISOString(),
      data: { app_id: payload['app_id'], user_id: payload['user_id'] },
    },
  };
}

export class PayoutModule {
  /**
   * B2-05e: the worker entry's account.went_negative consumer on queue evt.payout-went-negative
   * (registerEventConsumer: processed_events claim and the locked recheck in one transaction).
   * Registration runs no statement; without a database or queue nothing is registered and one
   * info line `went_negative_consumer_disabled` is logged.
   */
  /**
   * B2-05k: payout's recovery port for ledger (BR-WDR-05 (a)), global so LedgerModule's optional
   * BALANCE_RECOVERED_HOOK injection sees it on every entry that books money. The hook clears the
   * member's NEGATIVE_BALANCE blocks inside the posting that takes available back to >= 0.
   */
  static recovery(): DynamicModule {
    return {
      module: PayoutModule,
      global: true,
      providers: [
        {
          provide: BALANCE_RECOVERED_HOOK,
          inject: [CLOCK],
          useFactory: (clock: Clock) => createBalanceRecoveredHook({ clock }),
        },
      ],
      exports: [BALANCE_RECOVERED_HOOK],
    };
  }

  static forWorker(options: PayoutWorkerOptions): DynamicModule {
    return {
      module: PayoutModule,
      providers: [
        {
          provide: WENT_NEGATIVE_CONSUMER_TOKEN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
            eventBus?: EventBus,
          ): boolean => {
            if (db === undefined || queue === undefined || eventBus === undefined) {
              logger.info({ consumer: WENT_NEGATIVE_CONSUMER }, 'went_negative_consumer_disabled');
              return false;
            }
            const consumer = createWentNegativeConsumer({
              db,
              logger: logger.child({ module: 'payout' }),
              clock,
              ledger: createLedger({
                clock,
                eventBus,
                balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
              }),
              lockUsersForUpdate: options.lockUsersForUpdate,
              attempts: options.attempts,
              eventBus,
            });
            // B2-06d (BR-WDR-05 (a)): the payout process's W9 member_blocked enqueues a direct
            // recheck { app_id, user_id } on this queue; it is given the event envelope the
            // consumer expects before the shared registration sees it (one job, one claim).
            const normalized: Pick<QueueRuntime, 'register'> = {
              register(name, handler) {
                queue.register(name, (job) => handler(withEnvelope(job, clock)));
              },
            };
            registerEventConsumer(normalized, {
              consumer: WENT_NEGATIVE_CONSUMER,
              db,
              logger,
              handler: (event, trx) => consumer.handle(event, trx),
            });
            // B2-06fz (D10-326 C): the payout process only records a success / fail attempt and
            // enqueues one payout-landing job; this worker lands W5 / W6 as couli_app (ledger
            // voucher, users lock, event) through jobs/landing-job.ts.
            queue.register(
              PAYOUT_LANDING_QUEUE,
              createLandingJob({
                db,
                ledger: createLedger({
                  clock,
                  eventBus,
                  balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
                }),
                lockUsersForUpdate: options.lockUsersForUpdate,
                eventBus,
                clock,
                logger: logger.child({ module: 'payout' }),
              }),
            );
            return true;
          },
        },
      ],
    };
  }

  static forRoot(options?: PayoutModuleOptions): DynamicModule {
    const rulesProvider = provider(WITHDRAW_RULES, options?.rules, isRulesService);
    const applyProvider = provider(WITHDRAW_APPLY, options?.apply, isApplyService);
    const stepUpProvider = { provide: WITHDRAW_STEP_UP, useValue: options?.stepUp ?? null };
    const reads = options?.reads;
    const readsProvider =
      reads === undefined
        ? { provide: WITHDRAW_READS, useValue: null }
        : {
            provide: WITHDRAW_READS,
            inject: reads.inject ?? [],
            useFactory: async (...deps: unknown[]): Promise<DecryptWithdrawalAccount | null> => {
              const decrypt = await reads.useFactory(...deps);
              if (decrypt !== null) registerWithdrawalAccountDecrypt(decrypt);
              return decrypt;
            },
          };
    const handleProvider =
      options?.handle === undefined
        ? {
            provide: WITHDRAW_RULES_HANDLE,
            inject: [{ token: DB_TOKEN, optional: true }],
            useFactory: (db?: Kysely<DB>): Kysely<DB> | null => db ?? null,
          }
        : { provide: WITHDRAW_RULES_HANDLE, useValue: options.handle };
    return {
      module: PayoutModule,
      controllers: [WithdrawalsController],
      providers: [rulesProvider, applyProvider, stepUpProvider, readsProvider, handleProvider],
      exports: [WITHDRAW_RULES, WITHDRAW_APPLY],
    };
  }
}

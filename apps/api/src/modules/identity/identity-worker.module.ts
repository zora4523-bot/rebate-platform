// identity on the worker entry (B1-13g): the scheduled takeover / recheck of the paid bank-card
// verification records. app.module imports this module on `worker` only (the HTTP IdentityModule
// is never built there); entry.ts starts the timer after the worker services
// (startPayoutVerifyRecheck with payoutVerifyRecheckToken()). No controllers, no field cipher.
// Without a database payoutVerifyRecheckToken() provides null and one info line
// `payout_verify_recheck_disabled` is logged. The supplier is createBankCardVerifier(appEnv): the
// demo fake on local / test, null on staging / prod (one warn line `bank_card_verifier_unconfigured`;
// unknown rows then expire at their deadline, see ./application/payout-verify-recheck.ts).
//
// Also compiled by the `test` project: a class decorator only (dependencies through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import type { PayoutAccountConfigPort } from './application/payout-account.ts';
import { createPayoutAccountVerifyAttempts } from './application/payout-account-verify-attempts.ts';
import {
  createPayoutVerifyRecheck,
  payoutVerifyRecheckToken,
  type PayoutVerifyRecheck,
} from './application/payout-verify-recheck.ts';
import { createBankCardVerifier } from './infra/fake-bank-card-verifier.ts';

export interface IdentityWorkerModuleOptions {
  /** content's configuration reader on the caller's handle (app.module, as for IdentityModule). */
  readonly payoutAccountConfig: Omit<FactoryProvider<PayoutAccountConfigPort>, 'provide'>;
}

const WORKER_PAYOUT_ACCOUNT_CONFIG = Symbol('IDENTITY_WORKER_PAYOUT_ACCOUNT_CONFIG');

@Module({})
export class IdentityWorkerModule {
  static forWorker(options: IdentityWorkerModuleOptions): DynamicModule {
    return {
      module: IdentityWorkerModule,
      providers: [
        { ...options.payoutAccountConfig, provide: WORKER_PAYOUT_ACCOUNT_CONFIG },
        {
          provide: payoutVerifyRecheckToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            WORKER_PAYOUT_ACCOUNT_CONFIG,
            { token: DB, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            appConfig: AppConfig,
            config: PayoutAccountConfigPort,
            db?: Kysely<Database>,
          ): PayoutVerifyRecheck | null => {
            if (db === undefined) {
              logger.info({}, 'payout_verify_recheck_disabled');
              return null;
            }
            const verifier = createBankCardVerifier(appConfig.appEnv);
            if (verifier === null) logger.warn({}, 'bank_card_verifier_unconfigured');
            const attempts = createPayoutAccountVerifyAttempts({
              db,
              clock,
              logger,
              verifier,
              config,
            });
            return createPayoutVerifyRecheck({ db, clock, logger, attempts });
          },
        },
      ],
      exports: [payoutVerifyRecheckToken()],
    };
  }
}

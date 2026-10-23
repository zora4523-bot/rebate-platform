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
import { DB as DB_TOKEN } from '../platform/index.ts';
import type { WithdrawApplyService } from './application/withdraw-apply.ts';
import type { WithdrawRulesService } from './application/withdraw-rules.ts';
import {
  WithdrawalsController,
  type WithdrawStepUp,
} from './http/public/withdrawals.controller.ts';
import {
  WITHDRAW_APPLY,
  WITHDRAW_RULES,
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

export class PayoutModule {
  static forRoot(options?: PayoutModuleOptions): DynamicModule {
    const rulesProvider = provider(WITHDRAW_RULES, options?.rules, isRulesService);
    const applyProvider = provider(WITHDRAW_APPLY, options?.apply, isApplyService);
    const stepUpProvider = { provide: WITHDRAW_STEP_UP, useValue: options?.stepUp ?? null };
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
      providers: [rulesProvider, applyProvider, stepUpProvider, handleProvider],
      exports: [WITHDRAW_RULES, WITHDRAW_APPLY],
    };
  }
}

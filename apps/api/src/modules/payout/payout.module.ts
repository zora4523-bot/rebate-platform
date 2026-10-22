// B2-05c: the payout module on the api entry. app.module assembles the ports of the withdrawal
// rules use case (identity, risk, ledger, content's configuration reader, the default fee / tax
// calculator and the "nothing pending" re-verification gate) and hands them as `rules`; an entry
// without a database (contract smoke, tests) gets no use case and the controller refuses with
// 50001. `handle` overrides the process DB handle (tests only).
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { DB as DB_TOKEN } from '../platform/index.ts';
import type { WithdrawRulesService } from './application/withdraw-rules.ts';
import { WithdrawalsController } from './http/public/withdrawals.controller.ts';
import { WITHDRAW_RULES, WITHDRAW_RULES_HANDLE } from './tokens.ts';

export interface PayoutModuleOptions {
  /** A ready use case (tests), or a factory over the entry's providers (app.module). */
  rules?:
    | WithdrawRulesService
    | Pick<FactoryProvider<WithdrawRulesService | null>, 'inject' | 'useFactory'>;
  handle?: Kysely<DB>;
}

function isService(value: PayoutModuleOptions['rules']): value is WithdrawRulesService {
  return value !== undefined && typeof (value as WithdrawRulesService).getRules === 'function';
}

export class PayoutModule {
  static forRoot(options?: PayoutModuleOptions): DynamicModule {
    const rules = options?.rules;
    const rulesProvider =
      rules === undefined
        ? { provide: WITHDRAW_RULES, useValue: null }
        : isService(rules)
          ? { provide: WITHDRAW_RULES, useValue: rules }
          : { provide: WITHDRAW_RULES, ...rules };
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
      providers: [rulesProvider, handleProvider],
      exports: [WITHDRAW_RULES],
    };
  }
}

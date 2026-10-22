import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { WithdrawActor, WithdrawRulesService } from '../../application/withdraw-rules.ts';

export class WithdrawalsController {
  constructor(service: WithdrawRulesService, handle: Kysely<DB>) {
    void service;
    void handle;
    throw new Error('NotImplemented: WithdrawalsController');
  }

  getWithdrawRules(
    actor: WithdrawActor,
    amountFen?: bigint,
  ): Promise<components['schemas']['WithdrawRules']> {
    void actor;
    void amountFen;
    throw new Error('NotImplemented: getWithdrawRules');
  }
}

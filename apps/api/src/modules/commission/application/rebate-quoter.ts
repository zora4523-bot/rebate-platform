import type { CatalogConfigReader } from '../../catalog/index.ts';
import type { UserLevelReader } from '../../identity/index.ts';
import type { Clock } from '../../platform/index.ts';
import type { RuleSetReader } from '../domain/rules.ts';
import type { CommissionRebateQuoter } from './types.ts';

export interface CommissionRebateQuoterOptions {
  readonly rules: RuleSetReader;
  readonly levels: UserLevelReader;
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
}

/** BR-CALC-20: union.quoteN → domain.quoteRebate; no independent money formula here. */
export function createCommissionRebateQuoter(
  options: CommissionRebateQuoterOptions,
): CommissionRebateQuoter {
  void options;
  throw new Error('NotImplemented: createCommissionRebateQuoter');
}

import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RuleSetReader } from '../domain/rules.ts';

export interface RuleSetReaderOptions {
  readonly db: Kysely<DB>;
}

/** Read only app.commission_rule_versions / commission_rules / commission_rule_reserves. */
export function createRuleSetReader(options: RuleSetReaderOptions): RuleSetReader {
  void options;
  throw new Error('NotImplemented: createRuleSetReader');
}

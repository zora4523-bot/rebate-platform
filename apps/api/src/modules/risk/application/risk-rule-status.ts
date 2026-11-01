// Risk rule status read port (task B1-03zh; 规划/08 BR-ID-36 细则「规则清单的启停」, orchestrator
// ruling D10-536). Whether a rule of risk_rules takes part in judgements, by (app_id, rule_id):
//   - status disabled → it does not (the caller does not judge it and writes no risk_hits);
//   - status enabled, or active (what the hit writers register lazily) → it does;
//   - no row → it does (the writer registers the row on its first hit as before).
// Reads are cached on the injected Clock with the refresh period of configuration items (规划/04
// §10: the content module's configuration cache), so a change takes effect after that period and
// no completed judgement is revisited. Apps are isolated: one app's status never answers another's.
// Read only: nothing here writes risk_rules.
//
// Test stage skeleton: rule tests in test/spec/risk/rule-toggle-identity/**.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** One rule of one app (risk_rules unique key). */
export interface RiskRuleKey {
  readonly app_id: string;
  readonly rule_id: string;
}

export interface RiskRuleStatusReader {
  /**
   * true when the rule takes part in judgements now (enabled, active or no row), false when it is
   * disabled. `executor` (optional) is the handle to read through when the cached value is stale,
   * for callers inside a transaction of their own; without it the reader uses its own `db`.
   */
  isEnabled(key: RiskRuleKey, executor?: Kysely<DB>): Promise<boolean>;
}

export interface RiskRuleStatusReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export function createRiskRuleStatusReader(
  options: RiskRuleStatusReaderOptions,
): RiskRuleStatusReader {
  void options;
  throw new Error('NotImplemented: createRiskRuleStatusReader');
}

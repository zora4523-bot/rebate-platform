// B1-03zg: the display catalog of the risk rules (CT-24f adminListRiskRules; 规划/04 §3.2
// risk_rules name / threshold_keys). app.risk_rules has no name or threshold_keys column, so this
// code list, kept with the rule codes the risk writers register (B1-03 rule seed, BR-ID-36), gives
// each rule_id its display name and the keys of the configuration items (registered under
// config.risk, read and changed only through /admin/v1/config-items) that hold its thresholds.
// No migration. A rule_id the catalog lacks is listed with name = rule_id and threshold_keys = []
// and logged as a warn, never refused.
//
// Skeleton (test stage): every function throws NotImplemented.

/** One catalogued rule. */
export interface RiskRuleCatalogEntry {
  /** risk_rules.rule_id as the rule's writer registers it. */
  readonly ruleId: string;
  /** Display name (AdminRiskRule.name, 1–64 characters). */
  readonly name: string;
  /** Configuration item keys holding the rule's thresholds; empty for a rule without one. */
  readonly thresholdKeys: readonly string[];
}

/** Every catalogued rule, one entry per rule_id. */
export function riskRuleCatalog(): readonly RiskRuleCatalogEntry[] {
  throw new Error('NotImplemented: riskRuleCatalog');
}

/** The catalog entry of `ruleId`, or null when the catalog has none. */
export function riskRuleCatalogEntry(ruleId: string): RiskRuleCatalogEntry | null {
  void ruleId;
  throw new Error('NotImplemented: riskRuleCatalogEntry');
}

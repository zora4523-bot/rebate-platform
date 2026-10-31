// B1-03zg: the console's risk rule list and enable / disable (CT-24f adminListRiskRules,
// adminEnableRiskRule, adminDisableRiskRule; BR-ID-36 细则「规则清单的启停」; admin entry only).
//
// list(appId): every risk_rules row of the app, by scene, then rule_id; the eight AdminRiskRule
// fields only (never the conditions JSON); name and threshold_keys from ./risk-rule-catalog.ts.
// change(command): the compare-and-set lives in the SQL (WHERE app_id, rule_id and version =
// expected_version): a change sets the target status, adds 1 to version, stamps updated_at from
// the injected Clock and writes one audit record (risk_rule_enable / risk_rule_disable, before and
// after status, reason) in the same transaction; a rule already in the target status with a
// matching version is returned unchanged, without an audit record; a version mismatch is 20902
// (resource risk_rule); an unknown rule_id or one of another app is 20001 [rule_id].
//
// Skeleton (test stage): every method throws NotImplemented.
import type { DB as Database } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, RootLogger } from '../../platform/index.ts';

/** One row of the list, as the contract's AdminRiskRule. */
export type AdminRiskRuleView = Schema<'AdminRiskRule'>;

/** The two writes. */
export type AdminRiskRuleChange = 'enable' | 'disable';

export interface AdminRiskRulesOptions {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  /** Warns about a rule_id the catalog lacks. */
  readonly logger: RootLogger;
  /** Binds the audit port to the change's transaction (app.module: admin's audit writer). */
  readonly auditOn: (trx: Transaction<Database>) => AuditPort;
}

export interface AdminRiskRuleCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly ruleId: string;
  readonly change: AdminRiskRuleChange;
  readonly body: Schema<'AdminRiskRuleStatusChangeRequest'>;
}

export class AdminRiskRules {
  constructor(options: AdminRiskRulesOptions) {
    void options;
    throw new Error('NotImplemented: AdminRiskRules');
  }

  /** Every rule of the app, by scene, then rule_id. */
  list(appId: string): Promise<AdminRiskRuleView[]> {
    void appId;
    throw new Error('NotImplemented: AdminRiskRules.list');
  }

  /** Enables or disables one rule (compare-and-set on version); the rule as listed now. */
  change(command: AdminRiskRuleCommand): Promise<AdminRiskRuleView> {
    void command;
    throw new Error('NotImplemented: AdminRiskRules.change');
  }
}

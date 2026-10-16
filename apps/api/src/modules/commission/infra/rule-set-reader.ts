// B2-03c: Kysely reader of this module's own rule tables (app.commission_rule_versions,
// commission_rules, commission_rule_reserves). It returns every published, unrevoked version of
// one app with all of its rows, including versions not yet in force and versions whose rows are
// incomplete: choosing by time (BR-CALC-11) and rejecting incomplete versions (BR-CALC-06) are
// the domain's job, so nothing is filtered by an inner join. Read-only; no SQL clock.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RuleReserve, RuleRow, RuleSetReader, RuleVersion } from '../domain/rules.ts';

export interface RuleSetReaderOptions {
  readonly db: Kysely<DB>;
}

/** Read only app.commission_rule_versions / commission_rules / commission_rule_reserves. */
export function createRuleSetReader(options: RuleSetReaderOptions): RuleSetReader {
  const { db } = options;
  return {
    async publishedVersions(appId) {
      const app = db.withSchema('app');
      const versions = await app
        .selectFrom('commission_rule_versions')
        .select(['rule_version_id', 'effective_from', 'indirect_enabled'])
        .where('app_id', '=', appId)
        .where('status', '=', 'published')
        .where('revoked_at', 'is', null)
        .execute();
      if (versions.length === 0) return [];
      const ids = versions.map((v) => v.rule_version_id);
      const [ruleRows, reserveRows] = await Promise.all([
        app
          .selectFrom('commission_rules')
          .select([
            'rule_version_id',
            'platform',
            'level',
            'order_type',
            'r_own_bp',
            'r_direct_bp',
            'r_indirect_bp',
          ])
          .where('app_id', '=', appId)
          .where('rule_version_id', 'in', ids)
          .execute(),
        app
          .selectFrom('commission_rule_reserves')
          .select(['rule_version_id', 'platform', 'reserve_bp'])
          .where('app_id', '=', appId)
          .where('rule_version_id', 'in', ids)
          .execute(),
      ]);
      const rulesOf = new Map<string, RuleRow[]>(ids.map((id) => [id, []]));
      for (const r of ruleRows) {
        // Text columns hold contract codes (CHECK constraints); the domain validates them again.
        rulesOf.get(r.rule_version_id)?.push({
          platform: r.platform as RuleRow['platform'],
          level: r.level as RuleRow['level'],
          order_type: r.order_type as RuleRow['order_type'],
          r_own_bp: r.r_own_bp,
          r_direct_bp: r.r_direct_bp,
          r_indirect_bp: r.r_indirect_bp,
        });
      }
      const reservesOf = new Map<string, RuleReserve[]>(ids.map((id) => [id, []]));
      for (const r of reserveRows) {
        reservesOf.get(r.rule_version_id)?.push({
          platform: r.platform as RuleReserve['platform'],
          reserve_bp: r.reserve_bp,
        });
      }
      return versions.map((v): RuleVersion => {
        if (!(v.effective_from instanceof Date)) {
          throw new Error(
            `commission: published rule version ${v.rule_version_id} has no effective_from`,
          );
        }
        return {
          rule_version_id: v.rule_version_id,
          effective_from: v.effective_from,
          indirect_enabled: v.indirect_enabled,
          rules: rulesOf.get(v.rule_version_id) ?? [],
          reserves: reservesOf.get(v.rule_version_id) ?? [],
        };
      });
    },
  };
}

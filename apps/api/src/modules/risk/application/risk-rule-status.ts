// Risk rule status read port (task B1-03zh; 规划/08 BR-ID-36 细则「规则清单的启停」, orchestrator
// ruling D10-536). Whether a rule of risk_rules takes part in judgements, by (app_id, rule_id):
//   - status disabled → it does not (the caller does not judge it and writes no risk_hits);
//   - status enabled, or active (what the hit writers register lazily) → it does;
//   - no row → it does (the writer registers the row on its first hit as before).
// Reads are cached on the injected Clock with the refresh period of configuration items (规划/04
// §10: the content module's configuration cache, CONTENT_CACHE_TTL_MS), so a change takes effect
// after that period and no completed judgement is revisited. Apps are isolated: one app's status
// never answers another's.
// Read only: nothing here writes risk_rules.
//
// Freshness: an answer is served while its age (Clock now − the instant its load started) is in
// [0, ttl); at age ttl it is read again. A Clock now before the load counts as expired, so a
// backwards step never stretches an entry. A miss reads through `executor` when the caller gives
// one (its own transaction: nothing borrows a second pooled connection inside it), otherwise
// through `db`; a reader created without `db` must always be given an executor. A failed read is
// thrown, never cached (the caller fails closed as it does for any other database error).
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
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
  /** Default handle; may be left out by a reader whose every caller passes an executor. */
  readonly db?: Kysely<DB>;
  readonly clock: Clock;
  /** Cache period in milliseconds; defaults to RISK_RULE_STATUS_TTL_MS. */
  readonly ttlMs?: number;
}

/**
 * The configuration items' cache period (content's CONTENT_CACHE_TTL_MS, 规划/04 §10.2). Restated
 * here because risk may not import content's internals; a unit test pins the two together.
 */
export const RISK_RULE_STATUS_TTL_MS = 60_000;

/** The one stored status that keeps a rule out of judgements (contract AdminRiskRuleStatus). */
const DISABLED = 'disabled';
/** Cache bound: past it the whole cache is dropped and re-read on demand. */
const MAX_ENTRIES = 10_000;

interface Entry {
  readonly enabled: boolean;
  readonly loadedAtMs: number;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`risk rule status: ${field} must be a non-empty string`);
  }
  return value;
}

export function createRiskRuleStatusReader(
  options: RiskRuleStatusReaderOptions,
): RiskRuleStatusReader {
  const { db, clock } = options;
  const ttlMs = options.ttlMs ?? RISK_RULE_STATUS_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new RangeError('risk rule status: ttlMs must be a non-negative safe integer');
  }
  const entries = new Map<string, Entry>();

  return Object.freeze({
    async isEnabled(key: RiskRuleKey, executor?: Kysely<DB>): Promise<boolean> {
      if (typeof key !== 'object' || key === null) {
        throw new TypeError('risk rule status: key must be an object');
      }
      const appId = requireText(key.app_id, 'app_id');
      const ruleId = requireText(key.rule_id, 'rule_id');
      // JSON keeps the (app_id, rule_id) boundary unambiguous.
      const cacheKey = JSON.stringify([appId, ruleId]);
      const startedAtMs = clock.now().getTime();
      const cached = entries.get(cacheKey);
      if (cached !== undefined) {
        const age = startedAtMs - cached.loadedAtMs;
        if (age >= 0 && age < ttlMs) return cached.enabled;
      }
      const handle = executor ?? db;
      if (handle === undefined) {
        throw new TypeError('risk rule status: no executor and no default db');
      }
      const row = await handle
        .withSchema('app')
        .selectFrom('risk_rules')
        .select('status')
        .where('app_id', '=', appId)
        .where('rule_id', '=', ruleId)
        .executeTakeFirst();
      const enabled = row?.status !== DISABLED;
      if (entries.size >= MAX_ENTRIES && !entries.has(cacheKey)) entries.clear();
      entries.set(cacheKey, { enabled, loadedAtMs: startedAtMs });
      return enabled;
    },
  });
}

// Pure rule-version logic of the commission module (B2-03c): pick the version in force at an
// instant (BR-CALC-11) and take one viewer's quote terms from it (BR-CALC-06). No I/O, no clock,
// no money arithmetic. Every malformed or incomplete input throws; nothing falls back to another
// row, another version or a default value (module AGENTS.md hard rule 5).
//
// Also compiled by the `test` project (through the rule tests): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { components, UserLevel } from '@couli/contracts-ts';
import { validateRuleVersion, type RuleVersionRow } from '@couli/domain';

export interface RuleRow {
  readonly platform: components['schemas']['PlatformCode'];
  readonly level: UserLevel;
  readonly order_type: components['schemas']['OrderScope'];
  readonly r_own_bp: number;
  readonly r_direct_bp: number;
  readonly r_indirect_bp: number;
}

export interface RuleReserve {
  readonly platform: components['schemas']['PlatformCode'];
  readonly reserve_bp: number;
}

/** Only published, unrevoked versions cross the reader boundary; no time filtering there. */
export interface RuleVersion {
  readonly rule_version_id: string;
  readonly effective_from: Date;
  readonly indirect_enabled: boolean;
  readonly rules: readonly RuleRow[];
  readonly reserves: readonly RuleReserve[];
}

export interface RuleSetReader {
  publishedVersions(appId: string): Promise<readonly RuleVersion[]>;
}

/** Whole UTC seconds of a version's effective_from; anything but a valid Date throws. */
function effectiveSeconds(version: RuleVersion): number {
  const value: unknown = version.effective_from;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(
      `commission: rule version ${String(version.rule_version_id)} has no valid effective_from`,
    );
  }
  return Math.floor(value.getTime() / 1000);
}

/**
 * BR-CALC-11 / task §9: among the versions with effective_from ≤ at (compared in whole seconds,
 * boundary inclusive) take the one with the greatest effective_from. No eligible version, or two
 * eligible versions in the same second at the top (effective_from must be strictly increasing),
 * throws; there is no "earliest version" fallback for quotes. The input is not reordered.
 */
export function selectRuleVersion(versions: readonly RuleVersion[], at: Date): RuleVersion {
  const atValue: unknown = at;
  if (!(atValue instanceof Date) || !Number.isFinite(atValue.getTime())) {
    throw new TypeError('commission: quote instant is not a valid Date');
  }
  const atSeconds = Math.floor(atValue.getTime() / 1000);
  let best: RuleVersion | undefined;
  let bestSeconds = 0;
  let tie = false;
  for (const version of versions) {
    const seconds = effectiveSeconds(version);
    if (seconds > atSeconds) continue;
    if (best === undefined || seconds > bestSeconds) {
      best = version;
      bestSeconds = seconds;
      tie = false;
    } else if (seconds === bestSeconds) {
      tie = true;
    }
  }
  if (best === undefined) {
    throw new Error('commission: no published rule version is in force at the quote instant');
  }
  if (tie) {
    throw new Error('commission: two published rule versions share the same effective_from');
  }
  return best;
}

export interface QuoteTermsInput {
  readonly version: RuleVersion;
  readonly platforms: readonly components['schemas']['PlatformCode'][];
  readonly platform: components['schemas']['PlatformCode'];
  readonly level: UserLevel;
  readonly orderType: components['schemas']['OrderScope'];
}

/** A stored basis-point value must be a safe integer; range checks are validateRuleVersion's. */
function bp(value: unknown, what: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`commission: ${what} is not an integer basis-point value`);
  }
  return BigInt(value);
}

// The validator's time checks are not this function's concern (the version is already chosen
// by selectRuleVersion); one fixed valid +08:00 instant for both makes them pass trivially.
const UNUSED_INSTANT = '2026-01-01T00:00:00+08:00';

/**
 * BR-CALC-06 / 05 / 07: the selected version must cover commission.platforms × {L1, L2, L3} ×
 * {self, share} exactly once with every ratio present and in range, have one reserve_bp per
 * configured platform, keep r_indirect_bp at 0 when indirect is off and stay within the totals
 * cap; the same domain validator as publishing (validateRuleVersion) decides. Rows of platforms
 * outside commission.platforms are not part of the configured matrix and are ignored. Any
 * failure rejects the whole version; nothing is borrowed from another row or version.
 */
export function selectQuoteTerms(input: QuoteTermsInput): {
  readonly reserve_bp: bigint;
  readonly r_own_bp: bigint;
} {
  const { version, platforms, platform, level, orderType } = input;
  if (!platforms.includes(platform)) {
    throw new Error(`commission: platform ${String(platform)} is not in commission.platforms`);
  }
  const configured = new Set<string>(platforms);
  const rules: RuleVersionRow[] = [];
  for (const row of version.rules) {
    if (!configured.has(row.platform)) continue;
    const where = `rule ${String(row.platform)}/${String(row.level)}/${String(row.order_type)}`;
    rules.push({
      platform: row.platform,
      level: row.level,
      order_type: row.order_type,
      r_own_bp: bp(row.r_own_bp, `${where} r_own_bp`),
      r_direct_bp: bp(row.r_direct_bp, `${where} r_direct_bp`),
      r_indirect_bp: bp(row.r_indirect_bp, `${where} r_indirect_bp`),
    });
  }
  const reserves = version.reserves
    .filter((row) => configured.has(row.platform))
    .map((row) => ({
      platform: row.platform,
      reserve_bp: bp(row.reserve_bp, `reserve ${String(row.platform)}`),
    }));
  const indirectEnabled: unknown = version.indirect_enabled;
  if (typeof indirectEnabled !== 'boolean') {
    throw new TypeError('commission: rule version indirect_enabled is not a boolean');
  }
  const result = validateRuleVersion({
    draft: {
      indirect_enabled: indirectEnabled,
      effective_from: UNUSED_INSTANT,
      rules,
      reserves,
    },
    platforms,
    publish_at: UNUSED_INSTANT,
    published_effective_froms: [],
  });
  if (!result.ok) {
    const codes = [...new Set(result.errors.map((e) => e.code))].join(',');
    throw new Error(
      `commission: rule version ${String(version.rule_version_id)} is incomplete or invalid (${codes})`,
    );
  }
  // validateRuleVersion guarantees exactly one row and one reserve for these keys.
  const row = rules.find(
    (r) => r.platform === platform && r.level === level && r.order_type === orderType,
  );
  const reserve = reserves.find((r) => r.platform === platform);
  if (row === undefined || reserve === undefined) {
    throw new Error(`commission: no rule row for ${platform}/${level}/${orderType}`);
  }
  return { reserve_bp: reserve.reserve_bp, r_own_bp: row.r_own_bp };
}

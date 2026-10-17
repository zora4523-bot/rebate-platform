// Pure logic of the commission snapshot writer (B2-03g): pick the rule version in force at paid_at
// for a snapshot (BR-CALC-11, with the "earlier than the first version" fallback that quotes do
// not have), take each beneficiary's ratio from that version (BR-CALC-12), split through
// @couli/domain splitCommission (BR-CALC-02/04/05/13) and derive the four amounts (BR-CALC-27).
// No I/O, no clock. Money only through @couli/money and @couli/domain.
//
// Erasable syntax only, `import type` for type-only imports, relative imports with `.ts`.
import type { components, UserLevel } from '@couli/contracts-ts';
import { splitCommission, type CommissionBeneficiary } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import { selectRuleVersion, type RuleVersion } from './rules.ts';

type Platform = components['schemas']['PlatformCode'];
type OrderType = 'self' | 'share';
export type SnapshotRole = 'self' | 'share' | 'direct' | 'indirect';

export interface SnapshotPerson {
  readonly userId: string;
  readonly level: UserLevel;
  readonly status: 'active' | 'forfeited';
  readonly forfeitReason: string | null;
}

export interface SnapshotPeople {
  readonly owner: SnapshotPerson;
  readonly direct: SnapshotPerson | null;
  readonly indirect: SnapshotPerson | null;
}

export type SnapshotVersionChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'chosen'; readonly version: RuleVersion; readonly beforeFirst: boolean };

function validMs(value: unknown, what: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`commission: ${what} is not a valid Date`);
  }
  return value.getTime();
}

/**
 * BR-CALC-11 for snapshots: the version with the greatest effective_from ≤ paid_at (whole
 * seconds, boundary inclusive; a tie at the top throws, same口径 as selectRuleVersion). When
 * paid_at is earlier than every version, the version with the smallest effective_from is used and
 * `beforeFirst` is set so the caller warns (a tie at the bottom throws too). No version → none.
 */
export function selectSnapshotRuleVersion(
  versions: readonly RuleVersion[],
  paidAt: Date,
): SnapshotVersionChoice {
  const paidSeconds = Math.floor(validMs(paidAt, 'paid_at') / 1000);
  if (versions.length === 0) return { kind: 'none' };
  let earliest: RuleVersion | undefined;
  let earliestSeconds = 0;
  let anyInForce = false;
  for (const version of versions) {
    const seconds = Math.floor(
      validMs(version.effective_from, `rule version ${String(version.rule_version_id)}`) / 1000,
    );
    if (seconds <= paidSeconds) anyInForce = true;
    if (earliest === undefined || seconds < earliestSeconds) {
      earliest = version;
      earliestSeconds = seconds;
    }
  }
  if (earliest === undefined) return { kind: 'none' };
  if (anyInForce) {
    return { kind: 'chosen', version: selectRuleVersion(versions, paidAt), beforeFirst: false };
  }
  // At the earliest effective_from (same whole second) selectRuleVersion returns that version and
  // rejects a same-second tie at the bottom.
  const first = selectRuleVersion(versions, earliest.effective_from);
  return { kind: 'chosen', version: first, beforeFirst: true };
}

/** A stored basis-point value must be a safe integer; splitCommission checks the range. */
function bp(value: unknown, what: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`commission: ${what} is not an integer basis-point value`);
  }
  return BigInt(value);
}

function assertLevel(value: unknown, who: string): asserts value is UserLevel {
  if (value !== 'L1' && value !== 'L2' && value !== 'L3') {
    throw new TypeError(`commission: ${who} level is not L1/L2/L3`);
  }
}

function assertBigint(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== 'bigint') throw new TypeError(`commission: ${what} is not bigint fen`);
}

type Column = 'r_own_bp' | 'r_direct_bp' | 'r_indirect_bp';

/** The one row of (platform, level, order_type) in this version; missing → null, duplicate throws. */
function ratioOf(
  version: RuleVersion,
  platform: Platform,
  level: UserLevel,
  orderType: OrderType,
  column: Column,
): bigint | null {
  const rows = version.rules.filter(
    (r) => r.platform === platform && r.level === level && r.order_type === orderType,
  );
  if (rows.length > 1) {
    throw new Error(
      `commission: rule version ${version.rule_version_id} has duplicate rows for ${platform}/${level}/${orderType}`,
    );
  }
  const row = rows[0];
  if (row === undefined) return null;
  return bp(row[column], `rule ${platform}/${level}/${orderType} ${column}`);
}

function reserveOf(version: RuleVersion, platform: Platform): bigint | null {
  const rows = version.reserves.filter((r) => r.platform === platform);
  if (rows.length > 1) {
    throw new Error(
      `commission: rule version ${version.rule_version_id} has duplicate reserves for ${platform}`,
    );
  }
  const row = rows[0];
  return row === undefined ? null : bp(row.reserve_bp, `reserve ${platform}`);
}

export interface PlanSnapshotInput {
  readonly version: RuleVersion;
  readonly platform: Platform;
  readonly orderType: OrderType;
  readonly rebateMode: 'none' | 'normal' | null;
  readonly nBaseFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly tljRedpacketFen: bigint | null;
  readonly people: SnapshotPeople;
}

export interface PlannedBeneficiary {
  readonly user_id: string;
  readonly role: SnapshotRole;
  readonly ratio_bp: bigint;
  readonly level: UserLevel;
  readonly initial_status: 'active' | 'forfeited';
  readonly forfeit_reason: string | null;
  readonly amount_fen: bigint;
}

export interface SnapshotPlan {
  readonly kind: 'plan';
  readonly reserve_bp: bigint;
  readonly reserve_fen: bigint;
  readonly base_fen: bigint;
  readonly platform_retain_fen: bigint;
  /** splitCommission order: owner (self / share), direct, indirect. */
  readonly beneficiaries: readonly PlannedBeneficiary[];
  readonly n_total_fen: bigint;
  readonly pre_base_deduct_fen: bigint;
  readonly user_share_total_fen: bigint;
  readonly tlj_redpacket_fen: bigint | null;
  readonly platform_est_profit_fen: bigint | null;
  readonly warnings: readonly string[];
}

export type SnapshotPlanResult =
  SnapshotPlan | { readonly kind: 'pending'; readonly reason: string };

/**
 * Ratios come from the chosen version only, per (platform, beneficiary's paid_at level,
 * order_type): owner r_own_bp, direct r_direct_bp, indirect r_indirect_bp. A missing reserve or a
 * missing row for a beneficiary that takes part → pending (nothing borrowed from another row or
 * version). Indirect takes part only when the version enables it and a direct layer exists.
 * rebate_mode=none (BR-CALC-19: whole N to the platform) → every user ratio is 0.
 */
export function planSnapshot(input: PlanSnapshotInput): SnapshotPlanResult {
  const { version, platform, orderType, rebateMode, people } = input;
  assertBigint(input.nBaseFen, 'n_base_fen');
  assertBigint(input.subsidyCommissionFen, 'subsidy_commission_fen');
  assertBigint(input.tljDeductFen, 'tlj_deduct_fen');
  if (input.tljRedpacketFen !== null) {
    assertBigint(input.tljRedpacketFen, 'tlj_redpacket_fen');
    if (input.tljRedpacketFen < 0n) throw new RangeError('commission: tlj_redpacket_fen < 0');
  }
  if (rebateMode !== 'normal' && input.tljDeductFen !== 0n) {
    // BR-CALC-02: tlj_deduct_fen is non-zero only for our own tlj orders in normal mode.
    throw new RangeError('commission: tlj_deduct_fen must be 0 unless rebate_mode=normal');
  }
  if (typeof version.indirect_enabled !== 'boolean') {
    throw new TypeError('commission: rule version indirect_enabled is not a boolean');
  }

  const reserve = reserveOf(version, platform);
  if (reserve === null) {
    return { kind: 'pending', reason: `rule version has no reserve for ${platform}` };
  }

  const { owner, direct } = people;
  const indirect = version.indirect_enabled && direct !== null ? people.indirect : null;
  const parts: { person: SnapshotPerson; who: 'owner' | 'direct' | 'indirect'; column: Column }[] =
    [{ person: owner, who: 'owner', column: 'r_own_bp' }];
  if (direct !== null) parts.push({ person: direct, who: 'direct', column: 'r_direct_bp' });
  if (indirect !== null) parts.push({ person: indirect, who: 'indirect', column: 'r_indirect_bp' });

  const ratios = new Map<'owner' | 'direct' | 'indirect', bigint>();
  for (const { person, who, column } of parts) {
    assertLevel(person.level, who);
    const ratio = ratioOf(version, platform, person.level, orderType, column);
    if (ratio === null) {
      return {
        kind: 'pending',
        reason: `rule version has no rule row for ${platform}/${person.level}/${orderType} (${who})`,
      };
    }
    ratios.set(who, rebateMode === 'none' ? 0n : ratio);
  }
  const beneficiary = (who: 'owner' | 'direct' | 'indirect', person: SnapshotPerson) => {
    const ratio = ratios.get(who);
    if (ratio === undefined) throw new Error(`commission: missing ${who} ratio`);
    const out: CommissionBeneficiary = {
      user_id: person.userId,
      ratio_bp: ratio,
      status: person.status,
    };
    return out;
  };

  const split = splitCommission({
    n_base_fen: input.nBaseFen,
    reserve_bp: reserve,
    tlj_deduct_fen: input.tljDeductFen,
    order_type: orderType,
    indirect_enabled: version.indirect_enabled,
    owner: beneficiary('owner', owner),
    direct: direct === null ? null : beneficiary('direct', direct),
    indirect: indirect === null ? null : beneficiary('indirect', indirect),
  });

  const personOf = (role: SnapshotRole): SnapshotPerson => {
    const person = role === 'direct' ? direct : role === 'indirect' ? indirect : owner;
    if (person === null) throw new Error(`commission: splitCommission returned unknown ${role}`);
    return person;
  };
  const planned: PlannedBeneficiary[] = split.shares.map((share) => {
    const person = personOf(share.role);
    return {
      user_id: share.user_id,
      role: share.role,
      ratio_bp: share.ratio_bp,
      level: person.level,
      initial_status: person.status,
      forfeit_reason: person.status === 'forfeited' ? person.forfeitReason : null,
      amount_fen: share.amount_fen,
    };
  });

  let userTotal = 0n;
  for (const b of planned) userTotal = addFen(userTotal, b.amount_fen);
  const nTotal = addFen(input.nBaseFen, input.subsidyCommissionFen);
  const warnings: string[] = [...split.warnings];
  // BR-CALC-27: red packet is 0 for non-tlj orders; an unmatched tlj red packet keeps both null.
  const redpacket = rebateMode === null ? 0n : input.tljRedpacketFen;
  if (redpacket === null) warnings.push('TLJ_REDPACKET_UNMATCHED');
  const profit = redpacket === null ? null : subFen(subFen(nTotal, userTotal), redpacket);

  return {
    kind: 'plan',
    reserve_bp: reserve,
    reserve_fen: split.reserve_fen,
    base_fen: split.base_fen,
    platform_retain_fen: split.platform_retain_fen,
    beneficiaries: planned,
    n_total_fen: nTotal,
    pre_base_deduct_fen: subFen(nTotal, split.base_fen),
    user_share_total_fen: userTotal,
    tlj_redpacket_fen: redpacket,
    platform_est_profit_fen: profit,
    warnings,
  };
}

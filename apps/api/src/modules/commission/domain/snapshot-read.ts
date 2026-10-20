// Pure checks of the commission snapshot reader (B2-04i): validate the immutable beneficiary list
// stored in commission_splits.beneficiaries (BR-CALC-10), the role / version values read back
// from the snapshot tables, and the caller's expected commission_version against the order's
// greatest version (decision 39). No I/O, no clock, no money arithmetic.
//
// Erasable syntax only, `import type` for type-only imports, relative imports with `.ts`.
import type { UserLevel } from '@couli/contracts-ts';
import type { SnapshotRole } from './snapshot.ts';

export interface ReadSnapshotBeneficiary {
  readonly userId: string;
  readonly role: SnapshotRole;
  readonly ratioBp: number;
  readonly level: UserLevel;
  readonly initialStatus: 'active' | 'forfeited';
  readonly forfeitReason: string | null;
}

export interface SnapshotForfeitedEvent {
  readonly eventSeq: bigint;
  readonly userId: string;
  readonly role: SnapshotRole;
  readonly reason: string | null;
}

function fail(what: string): never {
  throw new TypeError(`commission: stored snapshot ${what}`);
}

export function parseSnapshotRole(value: unknown, what: string): SnapshotRole {
  if (value === 'self' || value === 'share' || value === 'direct' || value === 'indirect') {
    return value;
  }
  return fail(`${what} role is not self/share/direct/indirect`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The beneficiaries jsonb of a snapshot row, kept exactly as written (BR-CALC-10: user_id, role,
 * ratio_bp, level are immutable; initial_status / forfeit_reason are the snapshot-time verdict of
 * BR-CALC-13). Malformed content throws instead of being skipped or defaulted.
 */
export function parseSnapshotBeneficiaries(value: unknown): ReadSnapshotBeneficiary[] {
  if (!Array.isArray(value) || value.length === 0) fail('beneficiaries is not a non-empty array');
  const seen = new Set<string>();
  return value.map((item: unknown, i): ReadSnapshotBeneficiary => {
    const what = `beneficiary #${String(i)}`;
    if (!isRecord(item)) fail(`${what} is not an object`);
    const userId = item['user_id'];
    if (typeof userId !== 'string' || userId === '') fail(`${what} has no user_id`);
    const role = parseSnapshotRole(item['role'], what);
    const ratioBp = item['ratio_bp'];
    if (
      typeof ratioBp !== 'number' ||
      !Number.isSafeInteger(ratioBp) ||
      ratioBp < 0 ||
      ratioBp > 10000
    ) {
      fail(`${what} ratio_bp is not an integer in 0..10000`);
    }
    const level = item['level'];
    if (level !== 'L1' && level !== 'L2' && level !== 'L3') fail(`${what} level is not L1/L2/L3`);
    const initialStatus = item['initial_status'];
    if (initialStatus !== 'active' && initialStatus !== 'forfeited') {
      fail(`${what} initial_status is not active/forfeited`);
    }
    const forfeitReason = item['forfeit_reason'] ?? null;
    if (forfeitReason !== null && typeof forfeitReason !== 'string') {
      fail(`${what} forfeit_reason is not a string`);
    }
    const key = `${userId}\u0000${role}`;
    if (seen.has(key)) fail(`${what} repeats user_id + role`);
    seen.add(key);
    return { userId, role, ratioBp, level, initialStatus, forfeitReason };
  });
}

/** commission_version from the caller: a positive safe integer (column CHECK ≥ 1). */
export function assertCommissionVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('commission: commissionVersion is not a positive integer');
  }
}

/**
 * decision 39 / BR-CALC-10: the reader answers the order's greatest version only. A missing
 * version, or an expected version that is not the greatest one, throws — never an older amount,
 * never zero.
 */
export function assertCurrentVersion(
  expected: number,
  totalsMax: number | null,
  amountsMax: number | null,
): number {
  if (totalsMax === null || amountsMax === null) {
    throw new Error('commission: snapshot has no amount version');
  }
  if (totalsMax !== amountsMax) {
    throw new Error(
      `commission: snapshot totals version ${String(totalsMax)} and amounts version ${String(amountsMax)} differ`,
    );
  }
  if (expected !== totalsMax) {
    throw new Error(
      `commission: expected commission_version ${String(expected)} is not the current version ${String(totalsMax)}`,
    );
  }
  return totalsMax;
}

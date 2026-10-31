// B2-09h rule-test kit (claude-independent, SPEC_REF 9ab94dc0): contracts/openapi.yaml
// closeAdminReconDiff `outcome` and AdminReconDiffOutcome, contracts/enums/admin.yaml
// admin_recon_diff_outcome (CT-24zf, 编排裁定 D10-447 ②, D10-468 ②, D10-506), 08 BR-FUND-04 ④, 校验结果表
// 与例 2. The conclusion is resolution.outcome of a closed settle_amount_mismatch difference of source
// R1 on an order, bound to that difference's amounts; `closed` by itself and the free-text reason are
// not conclusions.
// Real pieces: the admin entry of ../admin-recon-close/kit.ts, ledger's public read port, PostgreSQL
// through @couli/db/testing as couli_app, Redis for the admin sessions. Synthetic: the recon_diffs,
// users and withdraw_holds rows, the admin accounts. No real user or merchant data.
// The shape of the read port (D10-506 ②, frozen here because the ruling names only its content):
// order_key → every 「以联盟为准」 conclusion of that order, each with the amounts it was reached on.
// An order can have several (D10-506 ③ re-opens a difference, and another bill month has its own), so
// one pair per key would lose the ones the current amounts might equal.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { readOnly } from '../../settlement/bill-ports/kit.ts';
import {
  ago,
  expectClosed,
  seedDiff,
  type AuditRow,
  type DiffRow,
  type Fixture,
} from '../admin-recon-close/kit.ts';
import type { DiffSeed, Resolution } from '../admin-recon-diffs/kit.ts';

export {
  CLOSE_ACTION,
  FAULT_POINTS,
  RECON,
  ago,
  allDiffs,
  allHolds,
  answer,
  audits,
  closed,
  conflict,
  denied,
  detailOf,
  detailView,
  diffNow,
  fixture,
  holdNow,
  holdRow,
  member,
  newKey,
  releasedBy,
  seedDiff,
  seedHold,
  sourceOf,
  suite,
  track,
  voucherCount,
  waiting,
  withCloseAdmin,
  type AuditRow,
  type DiffRow,
  type Fixture,
} from '../admin-recon-close/kit.ts';

// Loaded at run time through ledger's public exit, as the settlement rule tests do (the Nest module
// graph stays out of the test tsc).
export const ledger = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/ledger/application/recon-diff-conclusion.ts');

/** contracts/enums/admin.yaml admin_recon_diff_outcome. */
export const OUTCOMES = ['union', 'ours'] as const;
/** A bill month, the period of an R1 difference. */
export const PERIOD = '2026-09';

/** A synthetic order_key (`<platform>:<sub_order_id>`, recon_diffs.ref_id of an order). */
export function orderKey(): string {
  return `taobao:synthetic-${randomUUID()}`;
}

/** An R1 order difference of the fixture's app, open unless patched (例 2's amounts). */
export function r1Diff(f: Fixture, patch: DiffSeed = {}): Promise<DiffRow> {
  return seedDiff(f, {
    source: 'R1',
    type: 'settle_amount_mismatch',
    period: PERIOD,
    ref_type: 'order',
    ref_id: orderKey(),
    expected_fen: 1_234n,
    actual_fen: 1_100n,
    diff_fen: -134n,
    ...patch,
  });
}

/** An R1 order difference as a close with outcome=union leaves it, unless patched. */
export function unionDiff(f: Fixture, patch: DiffSeed = {}): Promise<DiffRow> {
  return r1Diff(f, {
    status: 'closed',
    closed_at: ago(f, 5),
    resolution: { reason: '联盟结算明细已核对', outcome: 'union' },
    ...patch,
  });
}

/** Ledger's read port in a read-only transaction: a write or a row lock there is refused. Sorted. */
export function unionKeys(
  db: Kysely<DB>,
  appId: string,
  orderKeys: readonly string[],
): Promise<string[]> {
  return readOnly(db, async (trx) =>
    [...(await ledger.readUnionAuthoritativeOrderKeys(trx, { appId, orderKeys })).keys()].sort(),
  );
}

/** The amounts one conclusion was reached on: its difference's expected_fen and actual_fen. */
export interface ConcludedAmounts {
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
}

/** The read port's whole answer (see the header), in a read-only transaction. */
export function unionConclusions(
  db: Kysely<DB>,
  appId: string,
  orderKeys: readonly string[],
): Promise<ReadonlyMap<string, readonly ConcludedAmounts[]>> {
  return readOnly(db, async (trx) => {
    const read: unknown = await ledger.readUnionAuthoritativeOrderKeys(trx, { appId, orderKeys });
    expect(read).toBeInstanceOf(Map);
    return read as ReadonlyMap<string, readonly ConcludedAmounts[]>;
  });
}

/** The row closed by `adminId` at the fixture's clock with exactly this resolution. */
export async function expectConcluded(
  f: Fixture,
  before: DiffRow,
  adminId: string,
  resolution: Resolution & { readonly reason: string },
): Promise<DiffRow> {
  const now = await expectClosed(f, before, adminId, resolution.reason);
  expect(now.resolution).toEqual(resolution);
  return now;
}

/** The before and after of an audit record as one text. */
export function auditText(record: AuditRow): string {
  return JSON.stringify({ before: record.before, after: record.after });
}

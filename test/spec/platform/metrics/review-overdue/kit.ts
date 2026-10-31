// B2-05o rule-test kit (规划/08 BR-WDR-26「超时判定 … 判定时状态仍 ∈ {PENDING_REVIEW, APPROVED} 即为审核
// 超时，此时 ① 告警财务（BR-WDR-24，不受夜间限制）」; BR-WDR-24「审核超时（BR-WDR-26）」必须告警; 编排
// 裁定 D10-475 ②(b), after D10-389 / B1-01zzp). The worker exports one unlabelled gauge,
// couli_withdrawals_review_overdue: the withdrawals across every app_id whose review_overdue_at is
// set (the B2-05n check judged them overdue) and whose status is still PENDING_REVIEW or APPROVED.
// couli-fund.yaml alerts on it > 0 with labels fund 'true' (night-pushed). The metric name, the
// counted statuses and the fixture's expected values are written out here, independent of the code
// under test. The Prometheus text reader comes from B1-01zzh's kit, the user / recording-database
// helpers from B1-01zzi's kit (read only, not changed). The test database comes from the int tests
// (@couli/db/testing is allowed in *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { insertUser, mentions } from '../../fund-metrics/kit.ts';
import { samples } from '../kit.ts';

// ---- the metric --------------------------------------------------------------------------------

/** The one gauge of this task: unlabelled, a whole count (BR-WDR-26 / BR-WDR-24). */
export const OVERDUE_METRIC = 'couli_withdrawals_review_overdue';

/** Statuses an overdue withdrawal still counts in: review not ended (BR-WDR-26 「审核结束」). */
export const COUNTED_STATUSES = ['PENDING_REVIEW', 'APPROVED'] as const;

/** Whether the text mentions the metric at all (a sample, HELP or TYPE line). */
export function mentionsOverdue(text: string): boolean {
  return new RegExp(`(^|[\\s{])${OVERDUE_METRIC}([\\s{]|$)`, 'm').test(text);
}

/** The gauge's value: exactly one sample line, without labels. */
export function overdueValue(text: string): number {
  const found = samples(text).filter((s) => s.name === OVERDUE_METRIC);
  expect(found.length, `${OVERDUE_METRIC}: exactly one sample`).toBe(1);
  expect(found[0]!.labels, `${OVERDUE_METRIC} has no labels`).toEqual({});
  return found[0]!.value;
}

/** The family's `# HELP` text (trimmed); fails when the line is missing. */
export function overdueHelp(text: string): string {
  const match = new RegExp(`^# HELP ${OVERDUE_METRIC} (.*)$`, 'm').exec(text);
  expect(match, `# HELP ${OVERDUE_METRIC}`).not.toBeNull();
  return match![1]!.trim();
}

/** A query of the review overdue read: it reads withdrawals and names review_overdue_at. */
export function isOverdueRead(query: string): boolean {
  return mentions(query, 'withdrawals') && /\breview_overdue_at\b/.test(query);
}

// ---- database fixtures -------------------------------------------------------------------------

/** The injected clock's instant of B1-01zzi's kit; the database's own now() is years earlier. */
export const NOW = '2031-04-05T06:07:08.000Z';

export const HOUR_MS = 3_600_000;

/** An ISO instant shifted by milliseconds. */
export function shift(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

export const APP_A = 'review_overdue_a';
export const APP_B = 'review_overdue_b';

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED';

export interface OverdueRow {
  readonly appId: string;
  readonly userId: string;
  readonly status: WithdrawalStatus;
  readonly reviewMode: 'auto' | 'manual' | null;
  /** The deadline (created_at + 24 workday hours); null for a row written before B2-05a. */
  readonly reviewDeadline: string | null;
  /** The instant the B2-05n check judged it overdue; null = not judged. */
  readonly overdueAt: string | null;
}

/** Inserts one withdrawal satisfying every CHECK of app.withdrawals; returns its id. */
export async function insertOverdueRow(db: Kysely<DB>, row: OverdueRow): Promise<string> {
  const id = randomUUID();
  const reviewed = row.status !== 'PENDING_REVIEW';
  const paid = row.status === 'PAID_API' || row.status === 'PAID_MANUAL';
  const manual = row.status === 'PAID_MANUAL';
  const createdAt = shift(row.reviewDeadline ?? NOW, -24 * HOUR_MS);
  const reviewedAt = reviewed ? shift(NOW, -HOUR_MS) : null;
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
       review_mode, review_deadline, review_overdue_at, reviewer_id, reviewed_at, needs_manual,
       paid_at, manual_entry_by, manual_confirm_by, reject_reason_code, fail_code, created_at,
       updated_at)
    VALUES (${id}, ${row.appId}, ${row.userId}, 10000, 0, 0, 10000, 'SERVICE_FEE', 'alipay',
      'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, ${row.status},
      ${id.replaceAll('-', '')}, 'alipay', ${row.reviewMode},
      ${row.reviewDeadline}::timestamptz, ${row.overdueAt}::timestamptz,
      ${row.reviewMode === 'manual' && reviewed ? randomUUID() : null}::uuid,
      ${reviewedAt}::timestamptz, false, ${paid ? reviewedAt : null}::timestamptz,
      ${manual ? randomUUID() : null}::uuid, ${manual ? randomUUID() : null}::uuid,
      ${row.status === 'REJECTED' ? 'RISK_SUSPECT' : null},
      ${row.status === 'FAILED' ? 'synthetic' : null},
      ${createdAt}::timestamptz, ${row.overdueAt ?? reviewedAt ?? createdAt}::timestamptz)`.execute(
    db,
  );
  return id;
}

/**
 * The fixture of the port tests. Comments give each row's contribution; the deadlines are all
 * past NOW, so "not judged yet" rows are past their deadline too: only review_overdue_at decides,
 * never the deadline. Returns the expected count and ids the tests move.
 */
export async function seedOverdue(db: Kysely<DB>): Promise<{
  expected: number;
  /** A counted PENDING_REVIEW row of APP_A (the tests move it on). */
  pendingId: string;
  /** A row past its deadline, PENDING_REVIEW, not judged yet (the tests judge it). */
  unjudgedId: string;
}> {
  const a = await insertUser(db, APP_A);
  const b = await insertUser(db, APP_B);
  const deadline = shift(NOW, -2 * HOUR_MS);
  const judged = shift(deadline, 5 * 60_000);
  const w = (
    appId: string,
    userId: string,
    status: WithdrawalStatus,
    overdueAt: string | null,
    reviewMode: 'auto' | 'manual' | null = status === 'PENDING_REVIEW' ? null : 'manual',
  ) =>
    insertOverdueRow(db, {
      appId,
      userId,
      status,
      reviewMode,
      reviewDeadline: deadline,
      overdueAt,
    });

  // Counted: 5 (across both app_ids, whatever the review mode).
  const pendingId = await w(APP_A, a, 'PENDING_REVIEW', judged);
  await w(APP_A, a, 'PENDING_REVIEW', judged);
  await w(APP_A, a, 'APPROVED', judged); // approved by a person, not yet executed
  await w(APP_A, a, 'APPROVED', judged, 'auto'); // auto-approved, still waiting (BR-WDR-26 对所有单适用)
  await w(APP_B, b, 'PENDING_REVIEW', judged); // another app_id: in the same total
  // Never counted: judged overdue, then the review ended (PAYING / PAID_MANUAL / REJECTED) or the
  // withdrawal reached another terminal state; review_overdue_at stays set.
  await w(APP_A, a, 'PAYING', judged);
  await w(APP_A, a, 'PAID_API', judged);
  await w(APP_A, a, 'PAID_MANUAL', judged);
  await w(APP_A, a, 'REJECTED', judged);
  await w(APP_A, a, 'FAILED', judged);
  await w(APP_B, b, 'REJECTED', judged);
  // Never counted: past the deadline but not judged yet (review_overdue_at NULL).
  const unjudgedId = await w(APP_A, a, 'PENDING_REVIEW', null);
  await w(APP_B, b, 'APPROVED', null);
  // Never counted: not judged and already terminal.
  await w(APP_A, a, 'PAID_API', null);
  // Never counted: no deadline at all (a row of the auto path) and not judged.
  await insertOverdueRow(db, {
    appId: APP_A,
    userId: a,
    status: 'APPROVED',
    reviewMode: 'auto',
    reviewDeadline: null,
    overdueAt: null,
  });
  return { expected: 5, pendingId, unjudgedId };
}

/** Moves a withdrawal's status (as a later state transition would), keeping review_overdue_at. */
export async function setStatus(
  db: Kysely<DB>,
  id: string,
  status: 'PAYING' | 'REJECTED',
): Promise<void> {
  await sql`UPDATE app.withdrawals
    SET status = ${status},
      reject_reason_code = ${status === 'REJECTED' ? 'RISK_SUSPECT' : null},
      reviewed_at = ${shift(NOW, -60_000)}::timestamptz,
      review_mode = 'manual',
      reviewer_id = ${randomUUID()}::uuid
    WHERE id = ${id}`.execute(db);
}

/** Sets review_overdue_at (as the B2-05n check would). */
export async function judge(db: Kysely<DB>, id: string): Promise<void> {
  await sql`UPDATE app.withdrawals SET review_overdue_at = ${NOW}::timestamptz WHERE id = ${id}`.execute(
    db,
  );
}

export async function withdrawalSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(w) AS row FROM app.withdrawals w ORDER BY id`.execute(db)).rows;
}

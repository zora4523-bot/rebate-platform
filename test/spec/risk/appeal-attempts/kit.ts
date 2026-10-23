// B1-03v (BR-ID-36 细则; D10-147): appeals count per (target, penalty_started_at).
// Shared helpers of the rule tests in this directory. penalty_started_at is not in the generated
// DB types until the migration lands, so every read or write of it here is raw SQL.
// Every test calls requirePenaltyColumns first: without the migration the test is red on that
// assertion, never on a PostgreSQL "column does not exist" error.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  RiskReasonCategory,
  RiskStateService,
} from '../../../../apps/api/src/modules/risk/index.ts';

type Db = Kysely<DB> | Transaction<DB>;

export interface Subject {
  readonly app_id: string;
  readonly user_id: string;
}

/** What the scenario helpers need: the business-role handle, the injected clock, the writer. */
export interface Driver {
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly riskState: Pick<RiskStateService, 'setRiskState'>;
  readonly subject: Subject;
}

/** Gap between two scenario steps: keeps created_at / closed_at / changed_at strictly ordered. */
export const STEP_MS = 10 * 60_000;
const WEEK_MS = 7 * 86400_000;

/** Both new columns: timestamptz, nullable, no default (no SQL clock, db/AGENTS.md rule 6). */
export async function requirePenaltyColumns(db: Db): Promise<void> {
  const result = await sql<{
    table_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT table_name::text AS table_name, data_type::text AS data_type,
           is_nullable::text AS is_nullable, column_default::text AS column_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND column_name = 'penalty_started_at'
      AND table_name IN ('appeals', 'user_risk_state')
    ORDER BY table_name
  `.execute(db);
  expect(result.rows, 'B1-03v 迁移：appeals 与 user_risk_state 各加 penalty_started_at').toEqual([
    {
      table_name: 'appeals',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'user_risk_state',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
  ]);
}

/** user_risk_state.penalty_started_at of the subject (the row must exist). */
export async function penaltyOf(db: Db, subject: Subject): Promise<Date | null> {
  const result = await sql<{ penalty_started_at: Date | null }>`
    SELECT penalty_started_at FROM app.user_risk_state
    WHERE app_id = ${subject.app_id} AND user_id = ${subject.user_id}
  `.execute(db);
  expect(result.rows, 'user_risk_state row').toHaveLength(1);
  return result.rows[0]!.penalty_started_at;
}

/** appeals.penalty_started_at of one appeal. */
export async function appealPenalty(db: Db, id: string): Promise<Date | null> {
  const result = await sql<{ penalty_started_at: Date | null }>`
    SELECT penalty_started_at FROM app.appeals WHERE id = ${id}
  `.execute(db);
  expect(result.rows, `appeal ${id}`).toHaveLength(1);
  return result.rows[0]!.penalty_started_at;
}

/** Simulates a stock row from before the migration (penalty unknown). Fixture-only write. */
export async function forgetPenalty(db: Db, subject: Subject): Promise<void> {
  const result = await sql`
    UPDATE app.user_risk_state SET penalty_started_at = NULL
    WHERE app_id = ${subject.app_id} AND user_id = ${subject.user_id}
  `.execute(db);
  expect(result.numAffectedRows).toBe(1n);
}

async function currentRow(d: Driver) {
  const row = await d.db
    .withSchema('app')
    .selectFrom('user_risk_state')
    .select(['state', 'reason', 'reason_category', 'frozen_until'])
    .where('app_id', '=', d.subject.app_id)
    .where('user_id', '=', d.subject.user_id)
    .executeTakeFirst();
  expect(row, 'user_risk_state row').toBeDefined();
  return row!;
}

/**
 * One console change through the single writer, STEP_MS after the previous step; returns the
 * instant of the change. frozen gets a freeze a week long unless `frozenUntil` is given.
 */
export async function setState(
  d: Driver,
  state: 'normal' | 'frozen' | 'banned',
  frozenUntil?: Date,
): Promise<Date> {
  d.clock.advanceMs(STEP_MS);
  const at = d.clock.now();
  await d.db.transaction().execute((trx) =>
    d.riskState.setRiskState(trx, {
      ...d.subject,
      state,
      reason: state === 'normal' ? null : `fixture ${state}`,
      reason_category: state === 'normal' ? null : 'other',
      frozen_until: state === 'frozen' ? (frozenUntil ?? new Date(at.getTime() + WEEK_MS)) : null,
      changed_by: 'admin:fixture',
    }),
  );
  return at;
}

/**
 * The appeal closer, which does not exist yet (CT-24r): upholds a processing account appeal.
 * Puts the state back (appealing → prev_risk_state, reason / category / frozen_until kept) through
 * the single writer and closes the appeal, both at the same instant STEP_MS after the last step.
 */
export async function uphold(d: Driver, appealId: string): Promise<Date> {
  d.clock.advanceMs(STEP_MS);
  const at = d.clock.now();
  const row = await currentRow(d);
  expect(row.state, 'an account appeal is being processed').toBe('appealing');
  const appeal = await d.db
    .withSchema('app')
    .selectFrom('appeals')
    .select(['prev_risk_state', 'status'])
    .where('id', '=', appealId)
    .executeTakeFirstOrThrow();
  expect(appeal.status).toBe('processing');
  await d.db.transaction().execute(async (trx) => {
    await d.riskState.setRiskState(trx, {
      ...d.subject,
      state: appeal.prev_risk_state as 'frozen' | 'banned',
      reason: row.reason,
      reason_category: row.reason_category as RiskReasonCategory | null,
      frozen_until: row.frozen_until,
      changed_by: 'admin:fixture',
    });
    const closed = await sql`
      UPDATE app.appeals
      SET status = 'upheld', closed_at = ${at}, handler_id = 'fixture_handler',
          updated_at = ${at}, row_version = row_version + 1
      WHERE id = ${appealId} AND status = 'processing'
    `.execute(trx);
    expect(closed.numAffectedRows).toBe(1n);
  });
  return at;
}

/**
 * A closed (or processing) appeal written directly, as the existing appeals fixtures do; the
 * penalty column is set explicitly (null = a stock row from before the migration).
 */
export async function seedAppeal(
  db: Db,
  subject: Subject,
  options: {
    readonly target_type?: 'account' | 'order';
    readonly target_id?: string;
    readonly status?: 'processing' | 'upheld' | 'revoked';
    readonly prev?: 'frozen' | 'banned';
    readonly created_at: Date;
    readonly penalty: Date | null;
  },
): Promise<string> {
  const id = randomUUID();
  const type = options.target_type ?? 'account';
  const status = options.status ?? 'upheld';
  const closed = status === 'processing' ? null : new Date(options.created_at.getTime() + 60_000);
  await sql`
    INSERT INTO app.appeals
      (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content,
       deadline_at, handler_id, closed_at, penalty_started_at, created_at, updated_at)
    VALUES (${id}, ${subject.app_id}, ${subject.user_id}, ${type},
      ${type === 'account' ? subject.user_id : (options.target_id ?? randomUUID())},
      ${type === 'account' ? (options.prev ?? 'frozen') : null}, ${status}, ${`申诉-${id}`},
      ${new Date(options.created_at.getTime() + WEEK_MS)},
      ${status === 'processing' ? null : 'fixture_handler'}, ${closed},
      ${type === 'account' ? options.penalty : null}, ${options.created_at}, ${options.created_at})
  `.execute(db);
  return id;
}

/** The attempt fields of a list page, keyed by appeal id. */
export function attemptsById(
  items: readonly { appeal_id: string; attempt_no: number; can_resubmit: boolean }[],
): Record<string, { attempt_no: number; can_resubmit: boolean }> {
  return Object.fromEntries(
    items.map((item) => [
      item.appeal_id,
      { attempt_no: item.attempt_no, can_resubmit: item.can_resubmit },
    ]),
  );
}

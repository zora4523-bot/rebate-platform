// B2-05n: the review overdue check of withdrawals (规划/08 BR-WDR-26 超时判定, BR-WDR-24 审核超时告警;
// 编排裁定 D10-467 ④, D10-475 ②).
//
// - Slots: one per 5 minutes, singletonKey `review-overdue:YYYY-MM-DDTHH:mm` (UTC, minutes rounded
//   down to a multiple of 5), pure functions of the instant handed in (as risk/domain/risk-scan-slots).
//   reviewOverdueSlot(now) is the slot `now` falls in (no delay); nextReviewOverdueSlot(now) the slot
//   after it, with the seconds until it is due (at least 1).
// - createReviewOverdueCheck(...).run(now): every app's withdrawals with review_deadline <= now,
//   review_overdue_at IS NULL and status in {PENDING_REVIEW, APPROVED}, ordered by review_deadline,
//   id; each one on its own transaction: identity's users lock → CAS review_overdue_at = now,
//   updated_at = now under the same conditions (0 rows: the row moved on or was judged meanwhile →
//   skipped, no event) → event withdrawal.review_overdue {withdrawal_id, user_id, review_deadline,
//   overdue_at} on that transaction (app_id on the envelope; no amount, no personal data); after the
//   commit one warn line 'withdrawal_review_overdue' { app_id, withdrawal_id, review_deadline,
//   overdue_at } (BR-WDR-24: the finance alert, not subject to quiet hours; a rollback writes none).
//   A failed withdrawal is a warn 'withdrawal_review_overdue_failed' (error_name) and does not stop
//   the others; the first failure is rethrown at the end so the queue retries the slot (a rerun is
//   idempotent: the column is set once by the CAS). Resolves { scanned, judged }.
// - The user notification (WD_OVERDUE, quiet hours, idempotency withdrawal_id:OVERDUE) is
//   notification's consumer of the event (identity lane); the gauge and the alert rule are B2-05o.
// Time only from the injected Clock / the instant handed in; no wall clock, no host time zone.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';

export const REVIEW_OVERDUE_EVENT = 'withdrawal.review_overdue';
export const REVIEW_OVERDUE_WARN = 'withdrawal_review_overdue';
export const REVIEW_OVERDUE_FAILED_WARN = 'withdrawal_review_overdue_failed';

/** Five minutes: the check's slot (BR-WDR-26 「每 5 分钟运行一次」). */
export const REVIEW_OVERDUE_SLOT_MS = 5 * 60_000;
const SLOT_KEY_PREFIX = 'review-overdue';

/** The statuses a withdrawal can be judged overdue in (BR-WDR-26: 审核未结束). */
const JUDGEABLE = ['PENDING_REVIEW', 'APPROVED'] as const;

export interface ReviewOverdueSlot {
  readonly singletonKey: string;
  /** Seconds until the slot is due; at least 1. Absent for a seed of the current slot. */
  readonly delaySeconds?: number;
}

export interface ReviewOverdueLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ReviewOverdueCheckOptions {
  /** couli_app: withdrawals (UPDATE review_overdue_at), the event log. */
  readonly db: Kysely<DB>;
  /** identity's users row lock (dependency inversion: app.module hands it in). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly logger: ReviewOverdueLogger;
}

export interface ReviewOverdueResult {
  /** Candidates selected (deadline passed, not judged, still waiting), before the locks. */
  readonly scanned: number;
  /** Rows the CAS moved: judged by this run. */
  readonly judged: number;
}

export interface ReviewOverdueCheck {
  run(now: Date): Promise<ReviewOverdueResult>;
}

interface Candidate {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly review_deadline: Date;
}

// ---- time slots -------------------------------------------------------------------------------

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function slotStartMs(ms: number): number {
  return ms - (ms % REVIEW_OVERDUE_SLOT_MS);
}

function slotKey(like: Date, startMs: number): string {
  return `${SLOT_KEY_PREFIX}:${dateAt(like, startMs).toISOString().slice(0, 16)}`;
}

/** The five-minute slot `now` falls in: what a worker seeds at startup (due at once). */
export function reviewOverdueSlot(now: Date): ReviewOverdueSlot {
  return { singletonKey: slotKey(now, slotStartMs(now.getTime())) };
}

/** The first slot after the one `now` falls in, with the delay until it is due. */
export function nextReviewOverdueSlot(now: Date): ReviewOverdueSlot {
  const ms = now.getTime();
  const due = slotStartMs(ms) + REVIEW_OVERDUE_SLOT_MS;
  return {
    singletonKey: slotKey(now, due),
    delaySeconds: Math.max(1, Math.ceil((due - ms) / 1000)),
  };
}

// ---- the check ---------------------------------------------------------------------------------

export function createReviewOverdueCheck(options: ReviewOverdueCheckOptions): ReviewOverdueCheck {
  const { db, lockUsersForUpdate, eventBus, logger } = options;

  /** Every app's candidates, read without a lock (the judgement re-checks under the lock). */
  async function candidates(now: Date): Promise<Candidate[]> {
    const rows = await db
      .withSchema('app')
      .selectFrom('withdrawals')
      .select(['id', 'app_id', 'user_id', 'review_deadline'])
      .where('review_deadline', 'is not', null)
      .where('review_deadline', '<=', now)
      .where('review_overdue_at', 'is', null)
      .where('status', 'in', [...JUDGEABLE])
      .orderBy('review_deadline', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.flatMap((row) =>
      row.review_deadline === null ? [] : [{ ...row, review_deadline: row.review_deadline }],
    );
  }

  /** One withdrawal: users row lock → CAS → event, all on one transaction; true when it moved. */
  async function judge(candidate: Candidate, now: Date): Promise<boolean> {
    const judged = await db.transaction().execute(async (trx) => {
      await lockUsersForUpdate(trx, { appId: candidate.app_id, userIds: [candidate.user_id] });
      // The locked re-check is the CAS itself: a withdrawal rejected, paid or judged since the
      // candidate read matches no row and is skipped.
      const moved = await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({ review_overdue_at: now, updated_at: now })
        .where('app_id', '=', candidate.app_id)
        .where('id', '=', candidate.id)
        .where('review_overdue_at', 'is', null)
        .where('status', 'in', [...JUDGEABLE])
        .where('review_deadline', 'is not', null)
        .where('review_deadline', '<=', now)
        .executeTakeFirst();
      if (moved.numUpdatedRows !== 1n) return false;
      await eventBus.publish(trx, {
        appId: candidate.app_id,
        name: REVIEW_OVERDUE_EVENT,
        payload: {
          withdrawal_id: candidate.id,
          user_id: candidate.user_id,
          review_deadline: candidate.review_deadline.toISOString(),
          overdue_at: now.toISOString(),
        },
      });
      return true;
    });
    if (judged) {
      // After the commit (D10-475 ②(b)): the finance alert line, ids and instants only.
      logger.warn(
        {
          app_id: candidate.app_id,
          withdrawal_id: candidate.id,
          review_deadline: candidate.review_deadline.toISOString(),
          overdue_at: now.toISOString(),
        },
        REVIEW_OVERDUE_WARN,
      );
    }
    return judged;
  }

  return {
    async run(now) {
      const found = await candidates(now);
      let judged = 0;
      let failure: { readonly error: unknown } | null = null;
      for (const candidate of found) {
        try {
          if (await judge(candidate, now)) judged += 1;
        } catch (error: unknown) {
          failure ??= { error };
          logger.warn(
            {
              app_id: candidate.app_id,
              withdrawal_id: candidate.id,
              error_name: error instanceof Error ? error.name : typeof error,
            },
            REVIEW_OVERDUE_FAILED_WARN,
          );
        }
      }
      if (failure !== null) throw failure.error;
      return { scanned: found.length, judged };
    },
  };
}

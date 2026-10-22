// User appeals (规划/08 BR-ID-36; 04 §3.2 appeals, §6.1; task B1-03i): POST /v1/me/appeals
// (submitAppeal) and GET /v1/me/appeals (listAppeals). Risk is the single writer of app.appeals;
// app.user_risk_state is written only through the risk state service (setRiskState).
//
// submit runs entirely on the caller's transaction (the platform idempotency claim's): never a
// pooled connection.
// - target_type=account: the appeal is always on the caller's own account (a target_id sent is
//   ignored; stored and returned target_id = user_id). The caller's user_risk_state row is read
//   from the database with a row lock (FOR UPDATE: never the cache), which serialises concurrent
//   submissions of one account: the later one waits for the earlier and then sees its appeal.
//   · banned / frozen without a processing account appeal → insert the appeal (processing,
//     prev_risk_state = the current state, deadline_at by the working-day calendar), then
//     setRiskState → appealing (reason, reason_category, frozen_until kept; changed_by
//     `user:<user_id>`; risk.state_changed published on the same transaction);
//   · banned / frozen / appealing with a processing account appeal → that appeal, nothing written;
//   · anything else (normal, no row, appealing without a processing appeal) → 20001, nothing written.
// - target_type=order: the order module is not there yet, so a voided rebate cannot be checked:
//   20001, nothing written (task ruling §9.3 #3).
//   TODO(规划/11 §4.5): 订单申诉受理与 30701 — blocked on B1-08 / B1-09 订单模块
//   · banned / frozen, no processing account appeal, and the appeals of the current penalty used
//     up (nextAppealAttempt above MAX_APPEAL_ATTEMPTS, the same rule as can_resubmit) → 30418,
//     nothing written (after "return the processing appeal", before the insert; CT-26e).
//
// attempt_no / can_resubmit (BR-ID-36 细则; CT-26e) are computed from the caller's own appeal
// history on the same target (account: target_id = user_id; order: the order_id), oldest first.
// There is no penalty column yet (04 §3.2 suggests penalty_started_at), so a "penalty" is
// approximated: a new one starts at the first appeal on a target, after a revoked appeal (the
// penalty was lifted), for the account when a freeze was escalated to a ban (frozen → banned is a
// new penalty, D10-147; banned → frozen is not, and the console cannot make it: freeze is only
// from normal or frozen, admin-risk-state.ts), and, for the next appeal (30418, can_resubmit),
// when user_risk_state.changed_at is later than the latest appeal's closed_at (the state was set
// again after that appeal closed: expiry, unfreeze or unban and a new penalty, or a re-freeze).
// This relies on the appeal closer putting the state back no later than closed_at; there is no
// closer yet. Boundaries between older penalties are not kept anywhere, so attempt_no of past
// appeals and the count behind the latest one can still run two penalties together.
// TODO(规划/11 §4.5): 按「同一处罚」精确计次 — blocked on 处罚分组字段 penalty_started_at（db / risk 任务）
// can_resubmit and the 30418 check share one rule, nextAppealAttempt: the attempt number the next
// appeal on the target would get. can_resubmit is true only for the latest appeal on its target,
// upheld, the target still restricted (account frozen with no past frozen_until, or banned), and
// nextAppealAttempt ≤ 3; so after the third upheld appeal of one penalty it is false. An order
// appeal is false until the order module can tell whether the order is still voided.
//
// list reads the caller's own account and order appeals (never blocked_request), newest first
// (created_at, then id, descending), keyset-paginated by an opaque cursor; deadline_at,
// handler_id, prev_risk_state and request_type are never returned.
//
// Logging: content, reason and calendar values are never logged.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';
import { resolveAppealDeadline } from './appeal-calendar.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import type { RiskReasonCategory, RiskStateService, RiskSubject } from './risk-state.ts';

export interface AppealsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskStateService;
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
  /**
   * The configuration port over a given handle. When present, submit reads the calendar on the
   * caller's transaction (inside a savepoint, so a failed read never aborts it) instead of
   * through `config`, so a submission never borrows a second pooled connection while holding one.
   */
  readonly configOn?: (handle: Kysely<DB>) => RateLimitConfigReader;
}

export type SubmitAppealResult =
  | { readonly code: 0; readonly data: Schema<'Appeal'> }
  | { readonly code: 20001 }
  | { readonly code: 30418 };

export interface AppealsService {
  /** The caller supplies the platform idempotency claim transaction. */
  submit(
    trx: Transaction<DB>,
    subject: RiskSubject,
    body: Schema<'SubmitAppealRequest'>,
  ): Promise<SubmitAppealResult>;
  list(
    subject: RiskSubject,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<Schema<'AppealListData'>>;
}

/** A list query outside the contract (cursor or limit): the HTTP layer answers 20001. */
export class AppealQueryError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`appeals: invalid ${fields.join(', ')}`);
    this.name = 'AppealQueryError';
    this.fields = fields;
  }
}

/** Contract Limit: default 20, at most 50 (04 §5). */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const REFUSED: SubmitAppealResult = Object.freeze({ code: 20001 });
const USED_UP: SubmitAppealResult = Object.freeze({ code: 30418 });
const NO_ATTEMPT: AppealAttempt = Object.freeze({ attempt_no: 1, can_resubmit: false });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond UTC instant as the cursor carries it (timestamptz keeps microseconds). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** BR-ID-36: at most three appeals per target and penalty, the first included. */
export const MAX_APPEAL_ATTEMPTS = 3;

interface AppealRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
  readonly content: string;
  readonly created_at: Date;
  readonly closed_at: Date | null;
}

/** One appeal of the history used for attempt_no / can_resubmit. */
export interface AppealHistoryRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
  readonly prev_risk_state: string | null;
  readonly created_at: Date;
  readonly closed_at: Date | null;
}

/** The account's current restriction (app.user_risk_state), for account appeals. */
export interface AccountRestriction {
  readonly state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly frozen_until: Date | null;
  /** user_risk_state.changed_at: when the state last changed. */
  readonly changed_at: Date;
}

export interface AppealAttempt {
  readonly attempt_no: number;
  readonly can_resubmit: boolean;
}

/** frozen → banned is a new penalty (D10-147); any other pair is the same penalty. */
function escalated(before: string | null, after: string | null): boolean {
  return before === 'frozen' && after === 'banned';
}

/**
 * The attempt number the next appeal on a target would get (BR-ID-36; the 30418 rule: above
 * MAX_APPEAL_ATTEMPTS means used up). `latest` is the target's latest appeal with its attempt_no;
 * `penalty` is the penalty the new appeal would be on (for the account, its current risk state;
 * null for an order); `penaltySince` is when that state was last set (user_risk_state.changed_at;
 * undefined when unknown). A state set after the latest appeal was closed is a new penalty: an
 * upheld appeal puts the state back no later than it closes, so a later change means the
 * penalty ended (expiry, unfreeze, unban) and another was imposed, or it was re-imposed.
 */
export function nextAppealAttempt(
  latest:
    | {
        readonly status: string;
        readonly prev_risk_state: string | null;
        readonly closed_at: Date | null;
      }
    | undefined,
  latestAttempt: number,
  penalty: string | null,
  penaltySince?: Date,
): number {
  if (latest === undefined || latest.status === 'revoked') return 1;
  if (escalated(latest.prev_risk_state, penalty)) return 1;
  if (
    penaltySince !== undefined &&
    latest.closed_at !== null &&
    penaltySince.getTime() > latest.closed_at.getTime()
  ) {
    return 1;
  }
  return latestAttempt + 1;
}

function targetKey(row: { readonly target_type: string; readonly target_id: string }): string {
  return `${row.target_type}:${row.target_id}`;
}

/**
 * attempt_no and can_resubmit for every appeal in `history` (BR-ID-36 细则), keyed by appeal id.
 * `account` is the caller's current risk state, read only when an account appeal needs it.
 */
export function appealAttempts(
  history: readonly AppealHistoryRow[],
  account: AccountRestriction | null,
  now: Date,
): ReadonlyMap<string, AppealAttempt> {
  const sorted = [...history].sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const previous = new Map<string, { row: AppealHistoryRow; attempt: number }>();
  const attempts = new Map<string, number>();
  for (const row of sorted) {
    const key = targetKey(row);
    const before = previous.get(key);
    const attempt = nextAppealAttempt(before?.row, before?.attempt ?? 0, row.prev_risk_state);
    attempts.set(row.id, attempt);
    previous.set(key, { row, attempt });
  }
  const result = new Map<string, AppealAttempt>();
  for (const row of sorted) {
    const attempt = attempts.get(row.id)!;
    const latest = previous.get(targetKey(row))!.row.id === row.id;
    let canResubmit = false;
    if (latest && row.status === 'upheld' && row.target_type === 'account' && account !== null) {
      const restricted =
        account.state === 'banned' ||
        (account.state === 'frozen' &&
          (account.frozen_until === null || account.frozen_until.getTime() > now.getTime()));
      // Same rule as 30418: the next appeal on the current penalty must still be within the cap.
      canResubmit =
        restricted &&
        nextAppealAttempt(row, attempt, account.state, account.changed_at) <= MAX_APPEAL_ATTEMPTS;
    }
    result.set(row.id, { attempt_no: attempt, can_resubmit: canResubmit });
  }
  return result;
}

function publicAppeal(row: AppealRow, attempt: AppealAttempt): Schema<'Appeal'> {
  return {
    appeal_id: row.id,
    target_type: row.target_type as Schema<'Appeal'>['target_type'],
    target_id: row.target_id,
    status: row.status as Schema<'Appeal'>['status'],
    content: row.content,
    created_at: row.created_at.toISOString(),
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
    attempt_no: attempt.attempt_no,
    can_resubmit: attempt.can_resubmit,
  };
}

const HISTORY_COLUMNS = [
  'id',
  'target_type',
  'target_id',
  'status',
  'prev_risk_state',
  'created_at',
  'closed_at',
] as const;

const APPEAL_COLUMNS = [
  'id',
  'target_type',
  'target_id',
  'status',
  'content',
  'created_at',
  'closed_at',
] as const;

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { readonly at: string; readonly id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppealQueryError(['cursor']);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !INSTANT.test(parsed[0]) ||
    Number.isNaN(Date.parse(parsed[0])) ||
    !UUID.test(parsed[1])
  ) {
    throw new AppealQueryError(['cursor']);
  }
  return { at: parsed[0], id: parsed[1] };
}

// TODO(规划/11 §3.2): 申诉提交写 audit_logs — blocked on audit_logs 只记后台操作人（规格同步任务）
export function createAppealsService(options: AppealsOptions): AppealsService {
  const { db, clock, riskState, config, logger, configOn } = options;

  /** The deadline, reading the calendar on `trx` inside a savepoint when configOn is wired. */
  async function deadlineOn(trx: Transaction<DB>, appId: string): Promise<Date> {
    if (configOn === undefined) return resolveAppealDeadline({ appId, clock, config, logger });
    await sql`SAVEPOINT appeal_calendar`.execute(trx);
    try {
      return await resolveAppealDeadline({ appId, clock, config: configOn(trx), logger });
    } finally {
      // The calendar only reads: undo whatever a failed read left behind, keep the transaction.
      await sql`ROLLBACK TO SAVEPOINT appeal_calendar`.execute(trx);
      await sql`RELEASE SAVEPOINT appeal_calendar`.execute(trx);
    }
  }

  /** The caller's own account and order appeals (never blocked_request), on `executor`. */
  async function history(
    executor: Kysely<DB> | Transaction<DB>,
    subject: RiskSubject,
    target?: { readonly target_type: string; readonly target_id: string },
  ): Promise<AppealHistoryRow[]> {
    let select = executor
      .withSchema('app')
      .selectFrom('appeals')
      .select(HISTORY_COLUMNS)
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .where('target_type', 'in', ['account', 'order']);
    if (target !== undefined) {
      select = select
        .where('target_type', '=', target.target_type)
        .where('target_id', '=', target.target_id);
    }
    return select.execute();
  }

  /** attempt_no / can_resubmit of `row`; a processing appeal never offers a resubmission. */
  async function attemptOf(
    trx: Transaction<DB>,
    subject: RiskSubject,
    row: AppealRow,
  ): Promise<AppealAttempt> {
    // Read on the caller's transaction, so a just-inserted appeal is part of its own history.
    const rows = await history(trx, subject, row);
    return appealAttempts(rows, null, clock.now()).get(row.id) ?? NO_ATTEMPT;
  }

  /** The caller's risk row, read from the database (never the cache); no row → null. */
  async function accountRestriction(subject: RiskSubject): Promise<AccountRestriction | null> {
    const row = await db
      .withSchema('app')
      .selectFrom('user_risk_state')
      .select(['state', 'frozen_until', 'changed_at'])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      state: row.state as AccountRestriction['state'],
      frozen_until: row.frozen_until,
      changed_at: row.changed_at,
    };
  }

  /** Whether a new account appeal on the current penalty (`state`) is within the cap (30418). */
  async function attemptsLeft(
    trx: Transaction<DB>,
    subject: RiskSubject,
    state: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await history(trx, subject, {
      target_type: 'account',
      target_id: subject.user_id,
    });
    const attempts = appealAttempts(rows, null, clock.now());
    let latest: AppealHistoryRow | undefined;
    for (const row of rows) {
      if (
        latest === undefined ||
        row.created_at.getTime() > latest.created_at.getTime() ||
        (row.created_at.getTime() === latest.created_at.getTime() && row.id > latest.id)
      ) {
        latest = row;
      }
    }
    const latestAttempt = latest === undefined ? 0 : (attempts.get(latest.id)?.attempt_no ?? 0);
    return nextAppealAttempt(latest, latestAttempt, state, since) <= MAX_APPEAL_ATTEMPTS;
  }

  async function processingAccountAppeal(
    trx: Transaction<DB>,
    subject: RiskSubject,
  ): Promise<AppealRow | undefined> {
    return trx
      .withSchema('app')
      .selectFrom('appeals')
      .select(APPEAL_COLUMNS)
      .where('app_id', '=', subject.app_id)
      .where('target_type', '=', 'account')
      .where('target_id', '=', subject.user_id)
      .where('status', '=', 'processing')
      .executeTakeFirst();
  }

  return {
    async submit(trx, subject, body) {
      if (body.target_type !== 'account') return REFUSED;
      const current = await trx
        .withSchema('app')
        .selectFrom('user_risk_state')
        .select(['state', 'reason', 'reason_category', 'frozen_until', 'changed_at'])
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) return REFUSED;
      const state = current.state;
      if (state !== 'banned' && state !== 'frozen' && state !== 'appealing') return REFUSED;
      const existing = await processingAccountAppeal(trx, subject);
      if (existing !== undefined) {
        return { code: 0, data: publicAppeal(existing, await attemptOf(trx, subject, existing)) };
      }
      if (state === 'appealing') return REFUSED;
      if (!(await attemptsLeft(trx, subject, state, current.changed_at))) return USED_UP;

      const deadline = await deadlineOn(trx, subject.app_id);
      const now = clock.now();
      const row: AppealRow = {
        id: newUuidV7(now),
        target_type: 'account',
        target_id: subject.user_id,
        status: 'processing',
        content: body.content,
        created_at: now,
        closed_at: null,
      };
      await trx
        .withSchema('app')
        .insertInto('appeals')
        .values({
          ...row,
          app_id: subject.app_id,
          user_id: subject.user_id,
          prev_risk_state: state,
          deadline_at: deadline,
          handler_id: null,
          updated_at: now,
        })
        .execute();
      // Called on the service object (not a detached function), on exactly this transaction.
      await riskState.setRiskState(trx, {
        app_id: subject.app_id,
        user_id: subject.user_id,
        state: 'appealing',
        reason: current.reason,
        reason_category: current.reason_category as RiskReasonCategory | null,
        frozen_until: current.frozen_until,
        changed_by: `user:${subject.user_id}`,
      });
      const attempt = await attemptOf(trx, subject, row);
      return { code: 0, data: publicAppeal(row, attempt) };
    },

    async list(subject, query) {
      const limit = query.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new AppealQueryError(['limit']);
      }
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      let select = db
        .withSchema('app')
        .selectFrom('appeals')
        .select(APPEAL_COLUMNS)
        .select(
          sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'cursor_at',
          ),
        )
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .where('target_type', 'in', ['account', 'order']);
      if (after !== undefined) {
        select = select.where(
          sql<boolean>`(created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        );
      }
      const rows = await select
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const all = page.length === 0 ? [] : await history(db, subject);
      const now = clock.now();
      // The account's current state matters only to an upheld account appeal (can_resubmit).
      const needsAccount = all.some(
        (row) => row.target_type === 'account' && row.status === 'upheld',
      );
      const account = needsAccount ? await accountRestriction(subject) : null;
      const attempts = appealAttempts(all, account, now);
      return {
        items: page.map((row) => publicAppeal(row, attempts.get(row.id) ?? NO_ATTEMPT)),
        next_cursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.cursor_at, last.id) : null,
      };
    },
  };
}

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
// The cumulative limit of three appeals per target is not applied (no contract code yet).
// TODO(规划/11 §4.5): 同一对象累计 3 次申诉上限 — blocked on 契约线分配拒绝码（08 §13.11）
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
  { readonly code: 0; readonly data: Schema<'Appeal'> } | { readonly code: 20001 };

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond UTC instant as the cursor carries it (timestamptz keeps microseconds). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface AppealRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
  readonly content: string;
  readonly created_at: Date;
  readonly closed_at: Date | null;
}

function publicAppeal(row: AppealRow): Schema<'Appeal'> {
  return {
    appeal_id: row.id,
    target_type: row.target_type as Schema<'Appeal'>['target_type'],
    target_id: row.target_id,
    status: row.status as Schema<'Appeal'>['status'],
    content: row.content,
    created_at: row.created_at.toISOString(),
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
  };
}

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
        .select(['state', 'reason', 'reason_category', 'frozen_until'])
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) return REFUSED;
      const state = current.state;
      if (state !== 'banned' && state !== 'frozen' && state !== 'appealing') return REFUSED;
      const existing = await processingAccountAppeal(trx, subject);
      if (existing !== undefined) return { code: 0, data: publicAppeal(existing) };
      if (state === 'appealing') return REFUSED;

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
      return { code: 0, data: publicAppeal(row) };
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
      return {
        items: page.map(publicAppeal),
        next_cursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.cursor_at, last.id) : null,
      };
    },
  };
}

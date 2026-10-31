// DELETION_PROGRESS inbox message (BR-TEXT-23, BR-ID-27, B1-15i): identity calls this on its own
// business transaction (no event): a request entering cooling writes `requested`, a user's
// withdrawal `cancelled`, the system's cancellation at the end of cooling with a negative balance
// `cancelled_negative`. Service category, inbox only: never a push or an SMS.
//
// On the caller's transaction, in this order: one notify_logs row (channel inbox, status success,
// dedupe key `{deletion_request_id}:DELETION_PROGRESS:{variant}`, ON CONFLICT (app_id, dedupe_key)
// DO NOTHING; a hit writes nothing more and answers false), the app's notify_templates override of
// (DELETION_PROGRESS, variant), then one inbox_messages row (title inbox.title.DELETION_PROGRESS
// 「注销进度」, route null). Timestamps come from the Clock. A failure anywhere fails the caller's
// transaction: the business write, the log and the message all roll back together.
//
// Bodies (BR-TEXT-23 细则模板表, verbatim; an override keeps the same variables):
//   requested           注销申请已提交，{cancel_deadline} 前可在「设置 → 账号与安全」撤回。
//   cancelled           已撤回注销申请，账号恢复正常使用。
//   cancelled_negative  你的账户有待扣回金额 {amount}，注销申请已撤销。后续返利抵扣回正后可重新申请，如有疑问请联系客服。
// {cancel_deadline}: BR-TEXT-11 future time in Asia/Shanghai (+08:00), 24-hour clock, "MM-DD HH:mm"
// in the clock's (+08:00) year, "YYYY-MM-DD HH:mm" otherwise. {amount}: formatYuan of amount_fen
// (BR-TEXT-10; amount_fen is the positive amount still to be recovered, −available_fen).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type DeletionProgressVariant = 'requested' | 'cancelled' | 'cancelled_negative';

interface DeletionProgressSubject {
  readonly app_id: string;
  readonly user_id: string;
  readonly deletion_request_id: string;
}

/** Entering cooling: cancel_deadline is the request's cooling_until. */
export interface DeletionRequestedInput extends DeletionProgressSubject {
  readonly variant: 'requested';
  readonly cancel_deadline: Date;
}

/** The user's withdrawal during cooling. */
export interface DeletionCancelledInput extends DeletionProgressSubject {
  readonly variant: 'cancelled';
}

/** The system's cancellation: amount_fen = −available_fen read in the same transaction (> 0). */
export interface DeletionCancelledNegativeInput extends DeletionProgressSubject {
  readonly variant: 'cancelled_negative';
  readonly amount_fen: bigint;
}

export type DeletionProgressInput =
  DeletionRequestedInput | DeletionCancelledInput | DeletionCancelledNegativeInput;

/** notify_templates title_override / body_override of (app, DELETION_PROGRESS, variant). */
export interface DeletionProgressOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface DeletionProgressMessage {
  readonly code: 'DELETION_PROGRESS';
  readonly variant: DeletionProgressVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

export interface DeletionProgressWriteOptions {
  readonly clock: Clock;
}

/**
 * BR-TEXT-23 default (or the override's title and body, applied independently) with the variables
 * filled; {cancel_deadline} is formatted against clock.now() in Asia/Shanghai.
 */
export function renderDeletionProgressMessage(
  input: DeletionProgressInput,
  override: DeletionProgressOverride | null,
  clock: Clock,
): DeletionProgressMessage {
  void input;
  void override;
  void clock;
  throw new Error('NotImplemented: renderDeletionProgressMessage');
}

/**
 * Writes one DELETION_PROGRESS inbox message and its notify_logs row on the caller's transaction.
 * true: written; false: the dedupe key was already logged (nothing written).
 */
export async function writeDeletionProgressMessage(
  trx: Transaction<DB>,
  input: DeletionProgressInput,
  options: DeletionProgressWriteOptions,
): Promise<boolean> {
  void trx;
  void input;
  void options;
  throw new Error('NotImplemented: writeDeletionProgressMessage');
}

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
import { accountingDate } from '@couli/domain';
import { formatYuan } from '@couli/money';
import type { Transaction } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';

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

const CODE = 'DELETION_PROGRESS';
/** BR-TEXT-09 细则标题表 inbox.title.DELETION_PROGRESS. */
const DEFAULT_TITLE = '注销进度';

/** BR-TEXT-23 细则模板表, verbatim. */
const DEFAULT_BODIES: Readonly<Record<DeletionProgressVariant, string>> = Object.freeze({
  requested: '注销申请已提交，{cancel_deadline} 前可在「设置 → 账号与安全」撤回。',
  cancelled: '已撤回注销申请，账号恢复正常使用。',
  cancelled_negative:
    '你的账户有待扣回金额 {amount}，注销申请已撤销。后续返利抵扣回正后可重新申请，如有疑问请联系客服。',
});

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * BR-TEXT-11 future time: 24-hour clock in Asia/Shanghai (+08:00); "MM-DD HH:mm" in the +08:00
 * year of now, "YYYY-MM-DD HH:mm" otherwise; never a relative word.
 */
function formatDeadline(deadline: Date, now: Date): string {
  const date = accountingDate(deadline);
  const local = deadline.getTime() + SHANGHAI_OFFSET_MS;
  const minuteOfDay = Math.floor((local - Math.floor(local / DAY_MS) * DAY_MS) / 60_000);
  const time = `${date.slice(5)} ${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
  return date.slice(0, 4) === accountingDate(now).slice(0, 4)
    ? time
    : `${date.slice(0, 4)}-${time}`;
}

/** Every occurrence, the replacement taken literally (no `$` replacement patterns). */
function fillAll(template: string, name: string, value: () => string): string {
  const token = `{${name}}`;
  return template.includes(token) ? template.split(token).join(value()) : template;
}

function fill(template: string, input: DeletionProgressInput, clock: Clock): string {
  switch (input.variant) {
    case 'requested':
      return fillAll(template, 'cancel_deadline', () =>
        formatDeadline(input.cancel_deadline, clock.now()),
      );
    case 'cancelled_negative':
      return fillAll(template, 'amount', () => formatYuan(input.amount_fen));
    case 'cancelled':
      return template;
  }
}

function assertInput(input: DeletionProgressInput): void {
  switch (input.variant) {
    case 'requested':
      if (
        !(input.cancel_deadline instanceof Date) ||
        !Number.isFinite(input.cancel_deadline.getTime())
      ) {
        throw new Error('notification: invalid cancel_deadline of DELETION_PROGRESS requested');
      }
      return;
    case 'cancelled_negative':
      // The amount still to be recovered (−available_fen of a negative balance) is positive.
      if (typeof input.amount_fen !== 'bigint' || input.amount_fen <= 0n) {
        throw new Error('notification: invalid amount of DELETION_PROGRESS cancelled_negative');
      }
      return;
    case 'cancelled':
      return;
    default:
      throw new Error('notification: unknown DELETION_PROGRESS variant');
  }
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
  assertInput(input);
  const title = override?.title_override ?? DEFAULT_TITLE;
  const body = fill(override?.body_override ?? DEFAULT_BODIES[input.variant], input, clock);
  return {
    code: CODE,
    variant: input.variant,
    category: 'service',
    channels: ['inbox'],
    title,
    body,
    route: null,
  };
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
  assertInput(input);
  const { clock } = options;
  const db = trx.withSchema('app');
  const now = clock.now();
  // The dedupe boundary first: ON CONFLICT DO NOTHING keeps the caller's transaction usable, and a
  // concurrent write of the same key waits on the unique key until the first transaction ends.
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: input.app_id,
      user_id: input.user_id,
      code: CODE,
      channel: 'inbox',
      dedupe_key: `${input.deletion_request_id}:${CODE}:${input.variant}`,
      planned_at: now,
      sent_at: now,
      status: 'success',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (logged === undefined) return false;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', input.app_id)
    .where('code', '=', CODE)
    .where('variant', '=', input.variant)
    .executeTakeFirst();
  const message = renderDeletionProgressMessage(input, override ?? null, clock);
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: newUuidV7(now),
      app_id: input.app_id,
      user_id: input.user_id,
      code: CODE,
      title: message.title,
      body: message.body,
      route: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return true;
}

// RISK_STATE_CHANGED inbox message (BR-TEXT-23, B1-12g): notification consumes risk.state_changed
// (payload of B1-03y) and writes one inbox message plus one notify_logs row in the consumer's
// transaction. Service category, inbox only: never a push or an SMS. The payload is the event's
// snapshot; user_risk_state is never read. Only unbanned reads one live fact at consumption time:
// whether the user's Taobao union binding is invalid ({need_reauth}), through linking's read port.
import type { RiskReasonCategory, RiskState } from '@couli/contracts-ts';
import type { Transaction } from 'kysely';
import type { DB } from '@couli/db';
import type { TaobaoReauthReader } from '../../linking/index.ts';
import { newUuidV7, type Clock, type EventHandler, type JobPayload } from '../../platform/index.ts';

/** B1-03y event snapshot; never read user_risk_state to reconstruct this payload. */
export interface RiskStateMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly user_id: string;
  readonly from: RiskState;
  readonly to: RiskState;
  readonly reason_category: RiskReasonCategory | null;
  readonly frozen_until: string | null;
}

export type RiskMessageVariant = 'frozen' | 'frozen_until' | 'unfrozen' | 'banned' | 'unbanned';

export interface RiskMessageOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface RiskStateMessage {
  readonly code: 'RISK_STATE_CHANGED';
  readonly variant: RiskMessageVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.notification-risk-state`. */
export const RISK_STATE_MESSAGE_CONSUMER = 'notification-risk-state';

const CODE = 'RISK_STATE_CHANGED';
const DEFAULT_TITLE = '账户通知';

/** BR-TEXT-23 细则表, verbatim. */
const DEFAULT_BODIES: Readonly<Record<RiskMessageVariant, string>> = Object.freeze({
  frozen: '你的账户提现已暂停，原因：{reason_category}。如有疑问，可在帮助中心提交申诉。',
  frozen_until:
    '你的账户提现已暂停至 {frozen_until}，原因：{reason_category}。如有疑问，可在帮助中心提交申诉。',
  unfrozen: '你的账户提现已恢复。',
  banned: '你的账号已被限制使用，原因：{reason_category}。可在说明页提交申诉。',
  unbanned: '你的账号限制已解除。{need_reauth}',
});

/** BR-TEXT-23 原因类别 user wording. */
/** BR-TEXT-23 {need_reauth} when the Taobao binding is invalid; otherwise the empty string. */
const NEED_REAUTH_TEXT = '购物前需重新完成淘宝授权。';

const REASON_TEXT: Readonly<Record<RiskReasonCategory, string>> = Object.freeze({
  malicious_rights: '异常售后维权',
  fraud_invite: '异常邀请行为',
  abnormal_trade: '异常交易',
  account_security: '账户安全核验',
  other: '违反用户协议',
});

const RISK_STATES: ReadonlySet<string> = new Set(['normal', 'frozen', 'appealing', 'banned']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Variant by the trigger column of BR-TEXT-23. Transitions into or out of appealing belong to
 * APPEAL_RESULT; any other transition without a variant (e.g. normal → normal) sends nothing.
 */
function variantOf(payload: RiskStateMessagePayload): RiskMessageVariant | null {
  const { from, to } = payload;
  if (from === 'appealing' || to === 'appealing') return null;
  if (to === 'frozen') return payload.frozen_until === null ? 'frozen' : 'frozen_until';
  if (to === 'banned') return 'banned';
  if (to === 'normal' && from === 'frozen') return 'unfrozen';
  if (to === 'normal' && from === 'banned') return 'unbanned';
  return null;
}

/** Civil date of a day count since 1970-01-01 (proleptic Gregorian; H. Hinnant). */
function civil(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

function shanghai(ms: number) {
  const local = ms + SHANGHAI_OFFSET_MS;
  const days = Math.floor(local / DAY_MS);
  const minuteOfDay = Math.floor((local - days * DAY_MS) / 60_000);
  return { ...civil(days), hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * BR-TEXT-11 future time: 24-hour clock in Asia/Shanghai (+08:00); "MM-DD HH:mm" in the year of
 * the clock's now, "YYYY-MM-DD HH:mm" otherwise; never a relative word.
 */
function formatExpiry(frozenUntil: string, now: Date): string {
  const ms = ISO_INSTANT.test(frozenUntil) ? Date.parse(frozenUntil) : Number.NaN;
  if (!Number.isFinite(ms))
    throw new Error('notification: invalid frozen_until of risk.state_changed');
  const at = shanghai(ms);
  const time = `${pad(at.month, 2)}-${pad(at.day, 2)} ${pad(at.hour, 2)}:${pad(at.minute, 2)}`;
  return at.year === shanghai(now.getTime()).year ? time : `${pad(at.year, 4)}-${time}`;
}

function fill(
  template: string,
  variant: RiskMessageVariant,
  payload: RiskStateMessagePayload,
  clock: Clock,
  needsTaobaoReauth: boolean,
): string {
  let body = template;
  if (variant === 'unbanned') {
    body = body.replaceAll('{need_reauth}', needsTaobaoReauth ? NEED_REAUTH_TEXT : '');
  }
  if (payload.reason_category !== null && body.includes('{reason_category}')) {
    body = body.replaceAll('{reason_category}', REASON_TEXT[payload.reason_category]);
  }
  if (payload.frozen_until !== null && body.includes('{frozen_until}')) {
    body = body.replaceAll('{frozen_until}', formatExpiry(payload.frozen_until, clock.now()));
  }
  return body;
}

/**
 * BR-TEXT-23 defaults; format expiry against clock in Asia/Shanghai; unmatched transitions return null.
 * unbanned: 你的账号限制已解除。{need_reauth}
 * need_reauth is 购物前需重新完成淘宝授权。 when needsTaobaoReauth is true, otherwise empty
 * (also every {need_reauth} of an unbanned body override).
 */
export function renderRiskStateMessage(
  payload: RiskStateMessagePayload,
  override: RiskMessageOverride | null,
  clock: Clock,
  needsTaobaoReauth?: boolean,
): RiskStateMessage | null {
  const variant = variantOf(payload);
  if (variant === null) return null;
  // A variant naming a reason needs one; the risk module always sets it outside normal.
  if (
    (variant === 'frozen' || variant === 'frozen_until' || variant === 'banned') &&
    (payload.reason_category === null || !Object.hasOwn(REASON_TEXT, payload.reason_category))
  ) {
    throw new Error('notification: risk.state_changed lacks a reason category');
  }
  const title = override?.title_override ?? DEFAULT_TITLE;
  const body = fill(
    override?.body_override ?? DEFAULT_BODIES[variant],
    variant,
    payload,
    clock,
    needsTaobaoReauth === true,
  );
  return {
    code: CODE,
    variant,
    category: 'service',
    channels: ['inbox'],
    title,
    body,
    route: null,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Checks the event data shape; a malformed event fails the job (retries, then dead letter). */
function readPayload(appId: string, data: JobPayload): RiskStateMessagePayload {
  const value = data as Partial<Record<keyof RiskStateMessagePayload, unknown>>;
  if (
    value.app_id !== appId ||
    typeof value.user_id !== 'string' ||
    typeof value.from !== 'string' ||
    !RISK_STATES.has(value.from) ||
    typeof value.to !== 'string' ||
    !RISK_STATES.has(value.to) ||
    !isNullableString(value.reason_category) ||
    (value.reason_category !== null && !Object.hasOwn(REASON_TEXT, value.reason_category)) ||
    !isNullableString(value.frozen_until)
  ) {
    throw new Error('notification: invalid risk.state_changed payload');
  }
  return value as RiskStateMessagePayload;
}

async function deliver(
  trx: Transaction<DB>,
  eventId: string,
  payload: RiskStateMessagePayload,
  clock: Clock,
  taobaoReauthReader: TaobaoReauthReader,
): Promise<void> {
  const variant = variantOf(payload);
  if (variant === null) return;
  const db = trx.withSchema('app');
  const now = clock.now();
  // The dedupe boundary first: ON CONFLICT DO NOTHING keeps the transaction usable, and a
  // concurrent delivery of the same event waits on the unique key until the first one ends.
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: payload.app_id,
      user_id: payload.user_id,
      code: CODE,
      channel: 'inbox',
      dedupe_key: `risk.state_changed:${eventId}`,
      planned_at: now,
      sent_at: now,
      status: 'success',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (logged === undefined) return;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', payload.app_id)
    .where('code', '=', CODE)
    .where('variant', '=', variant)
    .executeTakeFirst();
  // Consumption-time read on the consumer's transaction (SELECT only), for unbanned only.
  const reauth =
    variant === 'unbanned'
      ? await taobaoReauthReader(trx, { appId: payload.app_id, userId: payload.user_id })
      : false;
  const message = renderRiskStateMessage(payload, override ?? null, clock, reauth);
  if (message === null) return;
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: newUuidV7(now),
      app_id: payload.app_id,
      user_id: payload.user_id,
      code: CODE,
      title: message.title,
      body: message.body,
      route: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/**
 * Uses the event consumer's transaction for template lookup and both inserts.
 * notify_logs (app_id, dedupe_key) is the final deduplication boundary; a duplicate
 * resolves successfully without a new inbox row and leaves the transaction usable.
 * All delivery timestamps come from clock, never occurredAt or database time.
 */
export function createRiskStateMessageHandler(options: {
  readonly clock: Clock;
  /** Read current Taobao binding on the consumer transaction through linking, for unbanned. */
  readonly taobaoReauthReader: TaobaoReauthReader;
}): EventHandler {
  const { clock, taobaoReauthReader } = options;
  return async (event, trx) => {
    if (event.name !== 'risk.state_changed') {
      throw new Error('notification: unexpected event for the risk state message');
    }
    await deliver(
      trx,
      event.eventId,
      readPayload(event.appId, event.payload),
      clock,
      taobaoReauthReader,
    );
  };
}

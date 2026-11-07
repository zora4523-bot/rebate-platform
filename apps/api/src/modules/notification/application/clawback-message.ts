// B1-12zc (BR-TEXT-09, BR-TEXT-05, BR-TEXT-10, BR-FUND-09 细则; D10-773 方案 C): the CLAWBACK and
// SETTLE_ADJUSTED messages to an order's beneficiaries. One notification consumer,
// `notification-clawback` (queue `evt.notification-clawback`, worker only, concurrency 5), subscribes
// to both order.clawed_back and order.settle_adjusted. Rule-test skeleton: the contract below is
// what test/spec/notification/clawback-message/** and settle-adjusted-message/** pin.
//
// order.clawed_back (settlement clawback-order.ts, R8 / R9): order_id, order_key, rights_event_id,
// transition, reason (R8 only, an order_reason code), beneficiaries [{ user_id, role, clawback_fen
// (positive integer fen as a decimal string) }] — only those clawed back from their available
// balance are listed. One CLAWBACK message per listed beneficiary.
//
// order.settle_adjusted (D10-773 ④, producer booked separately): order_id, order_key, settle_seq
// (integer), sub_type (SETTLE_DIFF / PRICE_PROTECT / PRICE_COMPARE), beneficiaries [{ user_id, role,
// adjust_fen (signed integer fen as a decimal string), bucket }]. Only rows with adjust_fen < 0 and
// bucket user_available send a SETTLE_ADJUSTED message; every other row is ignored.
//
// Variants by role: self → self, share → share, direct / indirect → invite. Titles:
// CLAWBACK self「返利扣回」, share and invite「推广收益扣回」(inbox.title.CLAWBACK.self / .promo);
// SETTLE_ADJUSTED self「返利已调整」, share「推广收益已调整」, invite「邀请奖励已调整」.
// Bodies (BR-TEXT-09 table; D10-773 ④):
//   CLAWBACK self   「订单返利已扣回 {amount}：{reason.title}」
//   CLAWBACK share  「一笔分享订单的推广收益已扣回 {amount}：{reason.title}」
//   CLAWBACK invite 「一笔邀请订单的推广收益已扣回 {amount}」(no reason, J7)
//   SETTLE_ADJUSTED self   「订单返利已按结算金额调整，减少 {amount}：{reason.title}」
//   SETTLE_ADJUSTED share  「一笔分享订单的推广收益已按结算金额调整，减少 {amount}：{reason.title}」
//   SETTLE_ADJUSTED invite 「一笔邀请奖励已按结算金额调整，减少 {amount}」(no reason, J7)
// {amount}: CLAWBACK negative (-¥3.2); SETTLE_ADJUSTED the decrease's absolute value (¥3.2), both
// per BR-TEXT-10. {reason.title}: BR-TEXT-05 order_reason.<CODE>.title (CLAWBACK the event's
// reason, SETTLE_ADJUSTED the sub_type). Route: self and share → OrderDetail { order_id }; invite →
// Ledger without parameters (上级隐私: never the order). notify_templates title_override /
// body_override of (app, code, variant) apply independently.
//
// Service category: the inbox message is always written, the push follows the recipient's service
// switch (B1-12o createPushSendCore: record() in the event transaction, dispatch() after the
// commit). notify_logs dedupe keys: CLAWBACK `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}`,
// SETTLE_ADJUSTED `{order_key}:{user_id}:{role}:SETTLE_ADJ:{settle_seq}`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, EventHandler, ReceivedEvent, RootLogger } from '../../platform/index.ts';
import type { PushSendCore } from './push-send.ts';

export type DeductionCode = 'CLAWBACK' | 'SETTLE_ADJUSTED';

/** notify_templates variant: self, share, or invite (direct and indirect uplines). */
export type DeductionVariant = 'self' | 'share' | 'invite';

/** In-app jump target {route, params} (contracts/routes.json). */
export interface DeductionRoute {
  readonly route: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface DeductionOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

/** One beneficiary row of order.clawed_back, amounts parsed to bigint fen. */
export interface ClawbackFacts {
  readonly order_id: string;
  /** beneficiary_role: self, share, direct or indirect. */
  readonly role: string;
  /** The amount clawed back, integer fen above 0. */
  readonly clawback_fen: bigint;
  /** The event's order_reason code (R8), or null (R9 carries none). */
  readonly reason: string | null;
}

/** One beneficiary row of order.settle_adjusted, amounts parsed to bigint fen. */
export interface SettleAdjustedFacts {
  readonly order_id: string;
  /** beneficiary_role: self, share, direct or indirect. */
  readonly role: string;
  /** Signed integer fen; only a negative amount (a decrease) sends a message. */
  readonly adjust_fen: bigint;
  /** Where the adjustment was booked; only user_available sends a message. */
  readonly bucket: string;
  /** SETTLE_DIFF, PRICE_PROTECT or PRICE_COMPARE. */
  readonly sub_type: string;
}

export interface DeductionMessage {
  readonly code: DeductionCode;
  readonly variant: DeductionVariant;
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
  readonly route: DeductionRoute;
}

export interface OrderDeductionMessageOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** B1-12o: record() inside the event transaction, dispatch() on the root handle after commit. */
  readonly push: PushSendCore;
}

export interface OrderDeductionMessageConsumer {
  /** The event transaction: render and record inbox + notify_logs (+ push log) per recipient. */
  readonly handle: EventHandler;
  /** After the event transaction committed (root handle): dispatch the event's pushes, if any. */
  dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void>;
}

/** The CLAWBACK message of one beneficiary; null when the row sends nothing. */
export function renderClawbackMessage(
  facts: ClawbackFacts,
  override: DeductionOverride | null,
): DeductionMessage | null {
  void facts;
  void override;
  throw new Error('NotImplemented: renderClawbackMessage');
}

/** The SETTLE_ADJUSTED message of one beneficiary; null for an increase, zero or not user_available. */
export function renderSettleAdjustedMessage(
  facts: SettleAdjustedFacts,
  override: DeductionOverride | null,
): DeductionMessage | null {
  void facts;
  void override;
  throw new Error('NotImplemented: renderSettleAdjustedMessage');
}

/** The consumer of order.clawed_back and order.settle_adjusted. */
export function createOrderDeductionMessageConsumer(
  options: OrderDeductionMessageOptions,
): OrderDeductionMessageConsumer {
  void options;
  throw new Error('NotImplemented: createOrderDeductionMessageConsumer');
}

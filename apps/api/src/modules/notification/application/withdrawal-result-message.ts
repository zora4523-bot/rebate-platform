// B1-12u (BR-TEXT-09, BR-TEXT-08, BR-WDR-26; D10-228, D10-235, D10-260): the withdrawal result
// messages WD_SUCCESS / WD_REJECTED / WD_FAILED. notification consumes wallet.withdrawal_changed
// (payload {withdrawal_id, user_id, status}, D10-260) as consumer notification-withdrawal-result on
// queue evt.notification-withdrawal-result (worker only, concurrency 5).
//
// Only PAID_API / PAID_MANUAL → WD_SUCCESS, REJECTED → WD_REJECTED and FAILED → WD_FAILED are sent;
// any other status is acknowledged and writes nothing. The template follows the event's status
// (the withdrawal may have moved on since); amounts, reasons and the channel come from payout's
// read port createWithdrawalNotificationReader (B2-05l). An unknown withdrawal logs a warn and
// writes nothing. Service category: the inbox message is always written, the push follows the
// recipient's service switch (B1-12o push sending core: record() in the event transaction,
// dispatch() after the commit). notify_logs dedupe key `{withdrawal_id}:{status}` (BR-WDR-26).
// TODO(规划/11 §7.1): WD_FAILED 短信渠道 — blocked on 负责人短信签名与模板审批
//
// Test phase skeleton: every function throws NotImplemented.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
  Clock,
  EventHandler,
  JobPayload,
  ReceivedEvent,
  RootLogger,
} from '../../platform/index.ts';
import type { PushSendCore } from './push-send.ts';

/** D10-260: the wallet.withdrawal_changed payload, frozen. */
export interface WithdrawalResultMessagePayload extends JobPayload {
  readonly withdrawal_id: string;
  readonly user_id: string;
  readonly status: string;
}

export type WithdrawalResultCode = 'WD_SUCCESS' | 'WD_REJECTED' | 'WD_FAILED';

/** notify_templates variant: WD_REJECTED with NEGATIVE_BALANCE is `negative_balance` (D10-235). */
export type WithdrawalResultVariant = 'default' | 'negative_balance';

export type WithdrawalPayoutChannel = 'alipay' | 'bank_card' | 'wechat';

/** The event's status, and the withdrawal's fields as payout's read port returns them. */
export interface WithdrawalResultFacts {
  readonly status: string;
  readonly reject_reason_code: string | null;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fail_code: string | null;
  readonly payout_channel: WithdrawalPayoutChannel;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface WithdrawalResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface WithdrawalResultMessage {
  readonly code: WithdrawalResultCode;
  readonly variant: WithdrawalResultVariant;
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
}

/**
 * BR-TEXT-09 template of the event status with BR-TEXT-08 reasons and BR-TEXT-10 amounts; the
 * override's title and body apply independently. null for a status that sends nothing.
 */
export function renderWithdrawalResultMessage(
  facts: WithdrawalResultFacts,
  override: WithdrawalResultOverride | null,
): WithdrawalResultMessage | null {
  void facts;
  void override;
  throw new Error('NotImplemented: renderWithdrawalResultMessage');
}

export interface WithdrawalResultMessageOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** B1-12o: record() inside the event transaction, dispatch() on the root handle after commit. */
  readonly push: PushSendCore;
}

export interface WithdrawalResultMessageConsumer {
  /** The event transaction: read the withdrawal, render, record inbox + notify_logs (+ push log). */
  readonly handle: EventHandler;
  /** After the event transaction committed (root handle): dispatch the event's push, if any. */
  dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void>;
}

export function createWithdrawalResultMessageConsumer(
  options: WithdrawalResultMessageOptions,
): WithdrawalResultMessageConsumer {
  void options;
  throw new Error('NotImplemented: createWithdrawalResultMessageConsumer');
}

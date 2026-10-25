// B2-15c: one channel notification, from the raw request to the answer (08 BR-PAY-04 and 细则
// 「通知应答」, BR-PAY-05 ④, BR-PAY-08 ③; specs/pay-notify.md; task §9.1 ～ §9.4, §9.6, §9.8).
//
// In order:
//   ① the adapter verifies the signature and reads the fields (PayChannel.verifyNotification; the
//     WeChat APIv3 signature and resource decryption, the Alipay form signature live there, B2-15k);
//     rejected → count (pino warn pay_notify_rejected, flat fields, nothing of the body), no row,
//     answer «not success»;
//   ① the merchant / application identity must be ours (PayChannel.ownerAppOf → our app_id; a
//     notification never names our app_id itself); not ours → the same rejection;
//   then, in one transaction: our order of the out_trade_no (same app, same channel) is looked up,
//   the business object lock taken and the order re-read (BR-PAY-02 CAS 口径), the fixed checks
//   ②③④ run (domain/pay-result.ts) and the verdict acted on — settle (application/pay-settlement),
//   already paid (nothing), mismatch (kept, alerted once per order and reason), anomaly (BR-PAY-05
//   ④) — and the original is kept encrypted in pay_notifications (insert only, one row per
//   (app_id, pay_channel, notify_id), handle_result = what was decided). The answer follows the
//   table of BR-PAY-04 细则: success after the commit of a settlement, of a repeat, or of an
//   anomaly on a CLOSED order of ours; not success for a mismatch, for money on a number we have
//   no order of (the channel re-sends, every arrival is kept), and for any error (rolled back).
//   A notification that names a refund (out_refund_no set; B2-15e, BR-PAY-06 ④) goes to the one
//   refund result handler (application/pay-refund-result.ts, shared with the refund query):
//   succeed / fail / already final → kept and answered success after the commit; a mismatch (not
//   our refund, another original, another channel, another amount, a state in no list) → kept,
//   alerted with the refund numbers, answered «not success»; the amount stays held.
// Nothing of the original, the payer or the signature reaches a log line; the alerts carry ids,
// our merchant number and the reason only. Amounts stay bigint fen.
// Also compiled by the `test` project (through jobs/pay-jobs.ts imports of the shared pieces):
// erasable syntax only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { newUuidV7, type FieldCrypto } from '../../platform/index.ts';
import { judgePayResult, type PayResultVerdict } from '../domain/pay-result.ts';
import type { PayChannelCode } from '../domain/types.ts';
import {
  findOrderById,
  findOrderByOutTradeNo,
  hasNotificationResult,
  insertNotification,
  lockBizObject,
  type NewPayNotification,
} from '../infra/pay-order-store.ts';
import type {
  PayChannel,
  PayChannelSet,
  PayNotificationResult,
  PayRawNotification,
} from './pay-channel.ts';
import {
  PayRefundConflict,
  handleRefundReport,
  type PayRefundOutcome,
} from './pay-refund-result.ts';
import {
  PaySettlementConflict,
  registerAnomalyReceipt,
  settlePendingOrder,
  successStatesFor,
  type PaySettlementDeps,
} from './pay-settlement.ts';

export interface PayNotificationDeps extends PaySettlementDeps {
  readonly db: Kysely<DB>;
  readonly channels: Pick<PayChannelSet, 'of'>;
  /** The deployment's field cipher (payload_cipher); null → nothing can be kept, fail closed. */
  readonly crypto: Pick<FieldCrypto, 'encrypt'> | null;
}

/** The answer to the channel: success, or not (the format is the entry's, http/public). */
export type NotifyAnswer = 'ack' | 'nack';

/** Context of the field cipher for kept originals (platform/crypto: printable ASCII). */
export const NOTIFY_CIPHER_CONTEXT = 'pay_notifications.payload_cipher';

/** handle_result values written to pay_notifications (refund notifications: `refund_<outcome>`). */
export type NotifyHandleResult =
  | 'settled'
  | 'already_paid'
  | 'anomaly'
  | 'anomaly_no_order'
  | 'order_not_found'
  | 'amount_mismatch'
  | 'state_not_success'
  | 'refund_succeeded'
  | 'refund_failed'
  | 'refund_already_final'
  | 'refund_not_found'
  | 'refund_original_mismatch'
  | 'refund_channel_mismatch'
  | 'refund_amount_mismatch'
  | 'refund_state_not_listed';

/** The handle_result of a refund notification's outcome. */
function refundHandleResult(outcome: PayRefundOutcome): NotifyHandleResult {
  switch (outcome.verdict.kind) {
    case 'succeed':
      return 'refund_succeeded';
    case 'fail':
      return 'refund_failed';
    case 'already_final':
      return 'refund_already_final';
    case 'mismatch':
      return outcome.verdict.reason === 'refund_not_found'
        ? 'refund_not_found'
        : `refund_${outcome.verdict.reason}`;
    case 'rejected':
      // ① was checked before the transaction; unreachable with ours: true.
      throw new Error('payment: identity rejected inside the refund judgement');
  }
}

interface Decision {
  readonly answer: NotifyAnswer;
  readonly handleResult: NotifyHandleResult;
  readonly verdict: PayResultVerdict | null;
  /** The mismatch alert is due (first notification of this order with this reason). */
  readonly alert: boolean;
  readonly inserted: boolean;
  readonly payOrderId: string | null;
}

function rejected(
  deps: Pick<PayNotificationDeps, 'logger'>,
  channel: PayChannelCode,
  reason: string,
): NotifyAnswer {
  // Count and alert only: no row, no business trace (BR-PAY-04 细则 应答表 row 4).
  deps.logger.warn({ pay_channel: channel, reason }, 'pay_notify_rejected');
  return 'nack';
}

/**
 * Handles one raw notification of `channel` and returns how to answer. Throws only for failures
 * of our own side (the caller answers «not success» and logs the class).
 */
export async function handlePayNotification(
  deps: PayNotificationDeps,
  channel: PayChannelCode,
  raw: PayRawNotification,
): Promise<NotifyAnswer> {
  let adapter: PayChannel;
  try {
    adapter = deps.channels.of(channel);
  } catch {
    return rejected(deps, channel, 'channel_unavailable');
  }
  let verified: PayNotificationResult;
  try {
    verified = await adapter.verifyNotification(raw);
  } catch {
    return rejected(deps, channel, 'adapter_error');
  }
  if (verified.kind !== 'ok') return rejected(deps, channel, verified.reason);
  const appId = adapter.ownerAppOf({
    merchantRef: verified.merchantRef,
    appRef: verified.appRef,
  });
  if (appId === null) return rejected(deps, channel, 'identity_not_ours');
  if (verified.outTradeNo === null && verified.outRefundNo === null) {
    return rejected(deps, channel, 'no_merchant_number');
  }
  if (deps.crypto === null) {
    // payment/AGENTS.md rule 6: without the cipher nothing can be kept, so nothing is processed.
    deps.logger.error({ app_id: appId, pay_channel: channel }, 'pay_notify_crypto_missing');
    return 'nack';
  }
  const payloadCipher = Buffer.from(deps.crypto.encrypt(raw.body, NOTIFY_CIPHER_CONTEXT), 'utf8');
  const notification = {
    appId,
    payChannel: channel,
    notifyId: verified.notifyId,
    outTradeNo: verified.outTradeNo,
    outRefundNo: verified.outRefundNo,
    payloadCipher,
    verifyResult: 'ok' as const,
  };

  if (verified.outRefundNo !== null) {
    // A refund notification (BR-PAY-06 ④): the one refund result handler (B2-15e).
    return handleRefundNotification(deps, channel, appId, verified, notification);
  }
  if (verified.outTradeNo === null) return rejected(deps, channel, 'no_merchant_number');

  const outTradeNo = verified.outTradeNo;
  const successStates = await successStatesFor(deps, appId, channel);
  let decision: Decision;
  try {
    decision = await deps.db.transaction().execute(async (trx): Promise<Decision> => {
      let order = await findOrderByOutTradeNo(trx, appId, channel, outTradeNo);
      if (order !== undefined) {
        // 先取业务对象级锁再重读再判断 (BR-PAY-02; payment/AGENTS.md rule 3).
        await lockBizObject(trx, {
          appId: order.app_id,
          bizType: order.biz_type,
          bizRef: order.biz_ref,
        });
        order = await findOrderById(trx, appId, order.id);
      }
      const verdict = judgePayResult({
        ours: true,
        order:
          order === undefined
            ? null
            : {
                status: order.status as 'PENDING' | 'PAID' | 'CLOSED',
                amountFen: order.amount_fen,
              },
        amountFen: verified.amountFen,
        channelState: verified.state,
        successStates,
      });
      const now = deps.clock.now();
      let answer: NotifyAnswer;
      let handleResult: NotifyHandleResult;
      let alert = false;
      switch (verdict.kind) {
        case 'settle':
          if (order === undefined) throw new Error('payment: settle without an order');
          await settlePendingOrder(deps, trx, order, {
            channelTradeNo: verified.channelTradeNo,
            source: 'notify',
          });
          answer = 'ack';
          handleResult = 'settled';
          break;
        case 'already_paid':
          answer = 'ack';
          handleResult = 'already_paid';
          break;
        case 'mismatch':
          answer = 'nack';
          handleResult = verdict.reason;
          alert = !(await hasNotificationResult(trx, appId, channel, outTradeNo, handleResult));
          break;
        case 'anomaly':
          await registerAnomalyReceipt(deps, trx, {
            appId,
            payChannel: channel,
            channelTradeNo: verified.channelTradeNo,
            outTradeNo,
            payOrderId: order?.id ?? null,
            amountFen: verified.amountFen,
            channelState: verified.state,
            source: 'notify',
            evidenceRef: `pay_notification:${channel}:${verified.notifyId}`,
          });
          // 08 BR-PAY-04 应答表: a CLOSED order of ours → success after the commit (row 3); a
          // number we have no order of → not success (row 5; review r1 on AC#14).
          answer = verdict.orderFound ? 'ack' : 'nack';
          handleResult = verdict.orderFound ? 'anomaly' : 'anomaly_no_order';
          break;
        case 'rejected':
          // ① was checked before the transaction; unreachable with ours: true.
          throw new Error('payment: identity rejected inside the judgement');
      }
      const inserted = await insertNotification(trx, {
        ...notification,
        id: newUuidV7(now),
        handleResult,
        receivedAt: now,
      });
      return { answer, handleResult, verdict, alert, inserted, payOrderId: order?.id ?? null };
    });
  } catch (error: unknown) {
    if (error instanceof PaySettlementConflict) {
      deps.logger.warn(
        { app_id: appId, pay_channel: channel, pay_order_id: error.payOrderId },
        'pay_notify_conflict',
      );
      return 'nack';
    }
    throw error;
  }
  if (decision.verdict?.kind === 'mismatch' && decision.alert) {
    deps.logger.warn(
      {
        app_id: appId,
        pay_channel: channel,
        pay_order_id: decision.payOrderId,
        out_trade_no: outTradeNo,
        reason: decision.verdict.reason,
      },
      'pay_notify_mismatch',
    );
  }
  deps.logger.info(
    {
      app_id: appId,
      pay_channel: channel,
      pay_order_id: decision.payOrderId,
      result: decision.handleResult,
      duplicate: !decision.inserted,
    },
    'pay_notify_handled',
  );
  return decision.answer;
}

/** The verified fields of a notification (PayNotificationResult, kind ok). */
type VerifiedNotification = Extract<PayNotificationResult, { readonly kind: 'ok' }>;

/** The kept notification's fields that do not depend on the outcome. */
type NotificationDraft = Omit<NewPayNotification, 'id' | 'handleResult' | 'receivedAt'>;

/**
 * A verified refund notification of our identity (B2-15e, BR-PAY-06 ④): one transaction holds the
 * refund result handler (the target's lock, the fixed checks, RF2 / RF3 with everything ⑤ puts
 * next to them) and the kept original (handle_result = what was decided). The answer: success after
 * the commit of a succeed, a fail or a repeat of a decided refund; «not success» for a mismatch (the
 * channel re-sends, every arrival is kept, the amount stays held) and for any error (rolled back).
 * A refund notification without the refunded amount is never a result (fail closed: amount
 * mismatch). The mismatch alert names our refund numbers, never the original.
 */
async function handleRefundNotification(
  deps: PayNotificationDeps,
  channel: PayChannelCode,
  appId: string,
  verified: VerifiedNotification,
  notification: NotificationDraft,
): Promise<NotifyAnswer> {
  const outRefundNo = verified.outRefundNo;
  if (outRefundNo === null) throw new Error('payment: a refund notification names no refund');
  let outcome: PayRefundOutcome;
  let inserted: boolean;
  try {
    ({ outcome, inserted } = await deps.db.transaction().execute(async (trx) => {
      const decided = await handleRefundReport(deps, trx, {
        source: 'notify',
        channel,
        appId,
        ours: true,
        outRefundNo,
        outTradeNo: verified.outTradeNo,
        channelTradeNo: verified.channelTradeNo,
        refundFen: verified.refundFen ?? null,
        channelState: verified.state,
        channelRefundNo: verified.channelRefundNo ?? null,
      });
      const now = deps.clock.now();
      const kept = await insertNotification(trx, {
        ...notification,
        id: newUuidV7(now),
        handleResult: refundHandleResult(decided),
        receivedAt: now,
      });
      return { outcome: decided, inserted: kept };
    }));
  } catch (error: unknown) {
    if (error instanceof PayRefundConflict) {
      deps.logger.warn(
        { app_id: appId, pay_channel: channel, pay_refund_id: error.payRefundId },
        'pay_refund_notify_conflict',
      );
      return 'nack';
    }
    throw error;
  }
  const verdict = outcome.verdict;
  if (verdict.kind === 'mismatch') {
    // 任一项不符或状态不在清单内 → 记录并告警 (BR-PAY-06 ④): our numbers and the reason only.
    deps.logger.warn(
      {
        app_id: appId,
        pay_channel: channel,
        pay_refund_id: outcome.payRefundId,
        out_refund_no: outRefundNo,
        reason: verdict.reason,
      },
      'pay_refund_notify_mismatch',
    );
  }
  deps.logger.info(
    {
      app_id: appId,
      pay_channel: channel,
      pay_refund_id: outcome.payRefundId,
      result: refundHandleResult(outcome),
      duplicate: !inserted,
    },
    'pay_notify_handled',
  );
  return verdict.kind === 'mismatch' || verdict.kind === 'rejected' ? 'nack' : 'ack';
}

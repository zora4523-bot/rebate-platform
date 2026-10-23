// B2-15b: in-memory PayChannel for non-production environments and the rule tests (task §9.6).
// It never talks to a channel and signs nothing real; its launch parameters are synthetic, unique
// per createOrder call, and of the contract shape of its channel (PayLaunchWechatPay /
// PayLaunchAlipay). Scriptable: the next createOrder answers, and the trade state query / close
// see. Real adapters: B2-15k. NotImplemented skeleton (rule-test phase).
import type { PayChannelCode } from '../../domain/types.ts';
import type {
  PayBillResult,
  PayChannel,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayNotificationResult,
  PayQueryResult,
  PayRawNotification,
  PayRefundInput,
  PayRefundQueryResult,
  PayRefundResult,
  PayTradeState,
} from '../../application/pay-channel.ts';

/** Answer of one scripted createOrder call. */
export type FakeCreateAnswer = 'ok' | 'unknown';

/** What query / close see for a merchant order number; 'timeout' makes both answer unknown. */
export type FakeTradeSetting = PayTradeState | 'timeout';

export class FakePayChannel implements PayChannel {
  readonly channel: PayChannelCode;

  constructor(channel: PayChannelCode) {
    void channel;
    throw new Error('NotImplemented: FakePayChannel');
  }

  /**
   * Queues the answers of the next createOrder calls, first in first out; with none queued a call
   * answers ok. An ok call registers the trade as not_paid unless a state was set for it.
   */
  scriptCreate(answers: readonly FakeCreateAnswer[]): void {
    void answers;
    throw new Error('NotImplemented: FakePayChannel.scriptCreate');
  }

  /** Sets the trade state of `outTradeNo` as later query / close calls see it. */
  setTrade(outTradeNo: string, state: FakeTradeSetting): void {
    void outTradeNo;
    void state;
    throw new Error('NotImplemented: FakePayChannel.setTrade');
  }

  /** Every createOrder input received so far (ok and unknown alike), in call order. */
  createCalls(): readonly PayCreateOrderInput[] {
    throw new Error('NotImplemented: FakePayChannel.createCalls');
  }

  /** Scripted answer; ok carries fresh synthetic launch parameters of this channel's shape. */
  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    throw new Error('NotImplemented: FakePayChannel.createOrder');
  }

  /** The set state (amountFen of a created trade); never seen → not_exist; timeout → unknown. */
  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    throw new Error('NotImplemented: FakePayChannel.query');
  }

  /** not_paid becomes closed; paid stays paid; not_exist stays; timeout → unknown. */
  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    throw new Error('NotImplemented: FakePayChannel.close');
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    throw new Error('NotImplemented: FakePayChannel.refund');
  }

  refundQuery(outRefundNo: string): Promise<PayRefundQueryResult> {
    void outRefundNo;
    throw new Error('NotImplemented: FakePayChannel.refundQuery');
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    throw new Error('NotImplemented: FakePayChannel.verifyNotification');
  }

  downloadBill(date: string): Promise<PayBillResult> {
    void date;
    throw new Error('NotImplemented: FakePayChannel.downloadBill');
  }
}

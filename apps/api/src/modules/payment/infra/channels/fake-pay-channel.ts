// B2-15b: in-memory PayChannel for non-production environments and the rule tests (task §9.6).
// It never talks to a channel and signs nothing real; its launch parameters are synthetic, unique
// per createOrder call, and of the contract shape of its channel (PayLaunchWechatPay /
// PayLaunchAlipay). Scriptable: the next createOrder answers, and the trade state query / close
// see. Real adapters: B2-15k. No clock (the synthetic timestamp derives from the given deadline).
// Also compiled by the `test` project: erasable syntax only (no parameter properties).
import { randomBytes } from 'node:crypto';
import type { PayChannelCode } from '../../domain/types.ts';
import type {
  AlipayLaunch,
  PayBillResult,
  PayChannel,
  PayChannelIdentity,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayLaunch,
  PayNotificationResult,
  PayQueryResult,
  PayRawNotification,
  PayRefundInput,
  PayRefundQueryResult,
  PayRefundResult,
  PayTradeState,
  WechatLaunch,
} from '../../application/pay-channel.ts';

/** Answer of one scripted createOrder call. */
export type FakeCreateAnswer = 'ok' | 'unknown';

/** What query / close see for a merchant order number; 'timeout' makes both answer unknown. */
export type FakeTradeSetting = PayTradeState | 'timeout';

/** The reason of every scripted unknown answer (a synthetic transport timeout). */
export const FAKE_UNKNOWN_REASON = 'fake_timeout';

interface FakeTrade {
  state: FakeTradeSetting;
  amountFen: bigint | null;
}

function nonce(): string {
  return randomBytes(16).toString('hex');
}

/** The pay deadline as Unix seconds, digits only (contract: timestamp is Unix seconds as a string). */
function unixSeconds(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

export class FakePayChannel implements PayChannel {
  readonly channel: PayChannelCode;
  readonly #answers: FakeCreateAnswer[] = [];
  readonly #trades = new Map<string, FakeTrade>();
  readonly #calls: PayCreateOrderInput[] = [];
  #sequence = 0;

  constructor(channel: PayChannelCode) {
    this.channel = channel;
  }

  /**
   * Queues the answers of the next createOrder calls, first in first out; with none queued a call
   * answers ok. An ok call registers the trade as not_paid unless a state was set for it.
   */
  scriptCreate(answers: readonly FakeCreateAnswer[]): void {
    this.#answers.push(...answers);
  }

  /** Sets the trade state of `outTradeNo` as later query / close calls see it. */
  setTrade(outTradeNo: string, state: FakeTradeSetting): void {
    const trade = this.#trades.get(outTradeNo);
    this.#trades.set(outTradeNo, { state, amountFen: trade?.amountFen ?? null });
  }

  /** Every createOrder input received so far (ok and unknown alike), in call order. */
  createCalls(): readonly PayCreateOrderInput[] {
    return this.#calls.map((call) => ({ ...call }));
  }

  /** Scripted answer; ok carries fresh synthetic launch parameters of this channel's shape. */
  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    this.#calls.push({ ...input });
    const answer = this.#answers.shift() ?? 'ok';
    if (answer === 'unknown') {
      return Promise.resolve({ kind: 'unknown', reason: FAKE_UNKNOWN_REASON });
    }
    const trade = this.#trades.get(input.outTradeNo);
    this.#trades.set(input.outTradeNo, {
      state: trade?.state ?? 'not_paid',
      amountFen: input.amountFen,
    });
    this.#sequence += 1;
    const channelRef = `fake-${this.channel}-${this.#sequence}-${nonce()}`;
    return Promise.resolve({ kind: 'ok', launch: this.#launch(input, channelRef), channelRef });
  }

  /** Synthetic launch parameters of this channel's contract shape; nothing here is a real credential. */
  #launch(input: PayCreateOrderInput, channelRef: string): PayLaunch {
    if (this.channel === 'wechat_pay') {
      const launch: WechatLaunch = {
        appid: 'fake-wechat-appid',
        partnerid: 'fake-wechat-partnerid',
        prepayid: `fake-prepay-${channelRef}`,
        package: 'Sign=WXPay',
        noncestr: nonce(),
        timestamp: unixSeconds(input.expireAt),
        sign: nonce(),
      };
      return launch;
    }
    const launch: AlipayLaunch = {
      order_str: `fake_alipay_order_str&out_trade_no=${input.outTradeNo}&ref=${channelRef}&nonce=${nonce()}`,
    };
    return launch;
  }

  /** The set state (amountFen of a created trade); never seen → not_exist; timeout → unknown. */
  query(outTradeNo: string): Promise<PayQueryResult> {
    const trade = this.#trades.get(outTradeNo);
    if (trade === undefined) {
      return Promise.resolve({
        kind: 'ok',
        state: 'not_exist',
        channelTradeNo: null,
        amountFen: null,
      });
    }
    if (trade.state === 'timeout') {
      return Promise.resolve({ kind: 'unknown', reason: FAKE_UNKNOWN_REASON });
    }
    return Promise.resolve({
      kind: 'ok',
      state: trade.state,
      channelTradeNo: trade.state === 'paid' ? `fake-trade-${outTradeNo}` : null,
      amountFen: trade.amountFen,
    });
  }

  /** not_paid becomes closed; paid stays paid; not_exist stays; timeout → unknown. */
  close(outTradeNo: string): Promise<PayCloseResult> {
    const trade = this.#trades.get(outTradeNo);
    if (trade === undefined || trade.state === 'not_exist') {
      return Promise.resolve({ kind: 'ok', state: 'not_exist' });
    }
    if (trade.state === 'timeout') {
      return Promise.resolve({ kind: 'unknown', reason: FAKE_UNKNOWN_REASON });
    }
    if (trade.state === 'paid') return Promise.resolve({ kind: 'ok', state: 'paid' });
    trade.state = 'closed';
    return Promise.resolve({ kind: 'ok', state: 'closed' });
  }

  /** Refunds are B2-15f / B2-15k: the fake answers unknown, which the caller only queries. */
  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    return Promise.resolve({ kind: 'unknown', reason: 'fake_not_supported' });
  }

  refundQuery(outRefundNo: string): Promise<PayRefundQueryResult> {
    void outRefundNo;
    return Promise.resolve({ kind: 'unknown', reason: 'fake_not_supported' });
  }

  /** The fake signs nothing, so it verifies nothing: every notification is rejected (B2-15c). */
  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    return Promise.resolve({ kind: 'rejected', reason: 'fake_not_supported' });
  }

  /** B2-15c: the fake's own synthetic identity resolution (skeleton). */
  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    throw new Error('NotImplemented: FakePayChannel.ownerAppOf');
  }

  downloadBill(date: string): Promise<PayBillResult> {
    void date;
    return Promise.resolve({ kind: 'unknown', reason: 'fake_not_supported' });
  }
}

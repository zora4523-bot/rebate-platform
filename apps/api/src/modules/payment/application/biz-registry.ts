// B2-15b: business types registered for payment (08 BR-PAY-01 ① and 细则「业务类型登记的内容」; task
// §9.2). Registration is code: a new type needs its own BR entry, not just configuration. prod
// registers nothing; local / test / staging register only the test type `test_item` (1 fen,
// title 测试商品, sellable on the three apps, no user-side refund), used for 联调与验收 only.
// NotImplemented skeleton (rule-test phase).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { AppEnv } from '../../platform/index.ts';
import type { PayPlatform } from '../domain/types.ts';

/** The server-side price of one business object (BR-PAY-01 ①: the client never sends an amount). */
export interface BizPrice {
  /** Positive integer fen. */
  readonly amountFen: bigint;
  /** Order title sent to the channel as the description. */
  readonly title: string;
}

export interface BizPriceInput {
  readonly appId: string;
  readonly userId: string;
  readonly bizRef: string;
}

/** What the fulfilment handler recomputes from (BR-PAY-01 细则「业务类型的接入要求」). */
export interface BizReconcileInput {
  readonly appId: string;
  readonly bizType: string;
  readonly bizRef: string;
  /** The business object currently has a PAID order. */
  readonly paid: boolean;
  /** Refunded fen of that order so far. */
  readonly refundedFen: bigint;
}

/**
 * Grant / revoke of one business object, run serially per object (pay_fulfillments, D10-168):
 * every run recomputes the entitlement from the current payment facts and sets it, never «add on
 * grant, subtract on revoke». Registered here, executed from B2-15c on.
 */
export interface BizFulfillmentHandler {
  reconcile(trx: Transaction<DB>, input: BizReconcileInput): Promise<void>;
}

/** One registered business type. */
export interface BizTypeEntry {
  /** biz_type code (contract PayBizType: ^[a-z][a-z0-9_]*$). */
  readonly code: string;
  price(input: BizPriceInput): Promise<BizPrice>;
  /** Default sellable platforms; config `pay.biz.<biz_type>.platforms` replaces them. */
  readonly platforms: readonly PayPlatform[];
  readonly fulfillment: BizFulfillmentHandler;
  /** Whether the user side may ask for a refund (false for every type so far). */
  readonly userRefundAllowed: boolean;
}

export interface BizTypeRegistry {
  /** The registered type, or undefined (→ 30901 biz_not_sellable). */
  get(code: string): BizTypeEntry | undefined;
  list(): readonly BizTypeEntry[];
}

/** The registry of an APP_ENV: empty in prod; `test_item` only in local / test / staging. */
export function createBizRegistry(appEnv: AppEnv): BizTypeRegistry {
  void appEnv;
  throw new Error('NotImplemented: createBizRegistry');
}

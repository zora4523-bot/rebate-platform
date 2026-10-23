// B3-08a · BR-AI-01 / BR-AI-03 / BR-AI-05 / BR-AI-07: list_my_orders and explain_order. Both only
// for a phone-bound user; identity comes from ToolCallContext only. Search scope, own-number match
// and the shared-order projection are done by the orders module (B3-08f) and never redone here.
import type { AgentCapableOrderQueries } from '../../../orders/index.ts';
import type { Clock } from '../../../platform/index.ts';
import type { ClaimDraftDeps } from '../claim/index.ts';
import type { HandoffDeps } from '../handoff/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';

/** Resolves a card_id the model quotes to the order behind an order_status card of this session. */
export interface OrderCardRefs {
  resolve(
    cardId: string,
    ctx: ToolCallContext,
  ): Promise<{ readonly kind: 'order'; readonly orderId: string } | { readonly kind: 'invalid' }>;
}

/** Daily explain_order-by-order_no budget (BR-AI-07 判定 4); false means over the limit. */
export interface OrderNoQuota {
  take(appId: string, userId: string): Promise<boolean>;
}

export interface OrderToolsDeps {
  readonly orders: Pick<AgentCapableOrderQueries, 'searchForAgent' | 'findOwnByNumber' | 'get'>;
  readonly refs: OrderCardRefs;
  readonly quota: OrderNoQuota;
  readonly clock: Clock;
  config(appId: string, key: string): Promise<unknown>;
  readonly claim: ClaimDraftDeps;
  readonly handoff: HandoffDeps;
  cardReference?(ctx: ToolCallContext, index: number): string;
  texts?(appId: string, key: string): Promise<string>;
}

export function createListMyOrdersHandler(deps: OrderToolsDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createListMyOrdersHandler');
}

export function createExplainOrderHandler(deps: OrderToolsDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createExplainOrderHandler');
}

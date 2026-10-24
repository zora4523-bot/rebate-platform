// B3-03q rule-test kit. Two gaps left by B3-03p before the model path is switched on (BR-AI-05):
// the PG result store keeps the product of a written rebate_quote card (recordQuoted), and the
// no-model keyword search's result set becomes the session's current chain only once one of its
// product_list cards was confirmed as written. Existing kits are imported unchanged; every value
// here is synthetic.
import { expect } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  keepsQuoted,
  type DeliveredProduct,
  type QuotedReceiptStore,
  type ResultSetStore,
  type SessionChain,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import {
  numberCard,
  type RunContext,
  type UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type { CardFrame, Row } from '../stream-model-prereq/kit.ts';
import { product } from '../store-results/kit.ts';

export type { CardFrame, Row };

/**
 * `store` with its recordQuoted port. The check is an assertion, so a store without the port
 * fails here and never reaches a call of a missing method.
 */
export function quotedPort<T extends object>(store: T): T & QuotedReceiptStore {
  expect(keepsQuoted(store), 'the result store keeps quoted products (recordQuoted)').toBe(true);
  if (!keepsQuoted(store)) throw new Error('unreachable: asserted above');
  return store;
}

/** The receipt of a written rebate_quote card's product (the core's shape: product without card_id). */
export function quoted(
  cardId: string,
  productKey = 'jd:synthetic-quoted',
  finalPriceFen = 2590,
): DeliveredProduct {
  const item = product(productKey, finalPriceFen);
  return {
    card_id: cardId,
    product_key: item.product_key,
    platform: item.platform,
    final_price_fen: item.final_price_fen,
    card: {
      type: 'rebate_quote',
      schema_version: 1,
      data: { product: { ...item }, material: null, tlj_kind: 'unknown' },
      fallback_text: '合成报价卡',
    },
  };
}

/** A later round's tool call context in `sessionId` (reference lookups only). */
export function lookupOf(
  appId: string,
  sessionId: string,
  caller?: Pick<AgentCaller, 'userId' | 'deviceId' | 'phoneBound'>,
): ToolCallContext {
  return {
    appId,
    userId: caller?.userId ?? null,
    deviceId: caller?.deviceId ?? 'synthetic-device',
    phoneBound: caller?.phoneBound ?? false,
    runId: 'synthetic-next-run',
    sessionId,
    signal: new AbortController().signal,
    placeholders: {},
  };
}

/** The store's current chain of the session (both result stores have the chain port). */
export async function chainOf(
  store: ResultSetStore,
  appId: string,
  sessionId: string,
): Promise<SessionChain | null> {
  expect(store.currentChain, 'the result store has a chain port').toBeTypeOf('function');
  return (await store.currentChain?.(appId, sessionId)) ?? null;
}

/**
 * A run context like the RunManager's whose sink write fails: each card is numbered and handed
 * over, but the `delivered` receipt never comes (02 §9.2: no receipt, the card counts as not
 * written for references).
 */
export function unconfirmedContext(options: {
  readonly runId: string;
  readonly sessionId: string;
  readonly firstNo?: number;
}) {
  const controller = new AbortController();
  const frames: CardFrame[] = [];
  let next = options.firstNo ?? 1;
  const ctx: RunContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    signal: controller.signal,
    get cardsDelivered() {
      return 0;
    },
    text: () => undefined,
    toolStatus: () => undefined,
    suggestions: () => undefined,
    card: async (card: UnnumberedCard) => {
      const numbered = numberCard(card, next);
      next += numbered.used;
      frames.push(numbered.card);
    },
  };
  return { ctx, controller, frames };
}

/** The fixture's search row as another product (own key, raw id and title). */
export function rowAs(
  row: AgentSearchCandidate,
  itemId: string,
  title: string,
): AgentSearchCandidate {
  return {
    ...row,
    item: { ...row.item, item_id: itemId, title },
    ref: { ...row.ref, productKey: `tb:${itemId}`, rawItemId: itemId, title },
  };
}

/** The product_list items of the card frames of one streamed reply (frame data rows). */
export function listItemsOf(frames: readonly { event: string; data: Row }[]): Row[] {
  return frames
    .filter((frame) => frame.event === 'card' && frame.data['type'] === 'product_list')
    .flatMap((frame) => (frame.data['data'] as Row)['items'] as Row[]);
}

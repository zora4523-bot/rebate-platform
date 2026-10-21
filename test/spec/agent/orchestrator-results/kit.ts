import { expect, vi } from 'vitest';
import type {
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createClarification,
  createMemoryResultSetStore,
  createReferenceResolver,
  createRefinement,
  createResultsTools,
  type DeliveredProduct,
  type ResultSetInput,
  type ResultSetStore,
  type ResultsDeps,
  type SearchConditions,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createIntentPort } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import type { AgentProductCard } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { kit as intentKit, outputContext, request, copy } from '../orchestrator-intents/kit.ts';

export { request, copy };
export const BASE = {
  q: '合成牛奶',
  platforms: ['taobao', 'jd'],
  sort: 'sales_desc',
  spec: '24盒',
  page: 2,
  price_min_fen: 100,
  price_max_fen: 5000,
} as const;

export function product(key = 'jd:synthetic-a', price = 2990): AgentProductCard {
  return {
    product_key: key,
    item_ref: 'synthetic-ref',
    platform: 'jd',
    shop_type: null,
    title: '合成牛奶24盒',
    image: null,
    shop_name: '合成店铺',
    price_fen: 9000,
    coupon_fen: 0,
    final_price_fen: price,
    est_net_price_fen: null,
    rebate_min_fen: 10,
    rebate_max_fen: 10,
    rebate_basis: 'normal',
    benefit_tags: [],
    match_tag: 'matched',
    spec_text: null,
    is_presale: false,
    tlj: null,
    link_id: `synthetic-link-${key}`,
    cta: { text_key: 'product.buy' },
    quoted_at: '2026-10-19T12:00:00+08:00',
    stale: false,
    age_sec: 0,
    source: 'jd_union',
    disclaimer_keys: ['price_basis.general'],
    ad_label: null,
    availability: 'ok',
  };
}

export function list(id: string, items: readonly AgentProductCard[]): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: id, items: [...items], layout: 'list' },
    fallback_text: '合成商品列表',
  };
}

export function notice(key: string): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: key, actions: [] },
    fallback_text: copy(key),
  };
}

export function outcome(
  items: readonly AgentProductCard[] = [],
  id = 'synthetic-results',
  spec: string | null = '24盒',
  page = 2,
): Extract<ToolOutcome, { kind: 'ok' }> {
  // Extra runtime metadata is deliberately not asserted into ToolTraceFragment.
  const trace = { link_registrations: [], search_params: { spec, page } };
  return {
    kind: 'ok',
    cards: items.length === 0 ? [] : [list(id, items)],
    modelView: { items: [] },
    trace,
  };
}

export function cards(value: ToolOutcome): readonly UnnumberedCard[] {
  expect(value.kind).toBe('ok');
  return value.kind === 'ok' ? value.cards : [];
}

export function noticeKeys(value: ToolOutcome | readonly UnnumberedCard[]): string[] {
  const entries = 'kind' in value ? cards(value) : value;
  return entries
    .filter((c) => c.type === 'notice')
    .map((c) => {
      const data = c.data as { text_key: string };
      return data.text_key;
    });
}

export function delivered(cardId: string, item = product()): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: item.product_key,
    platform: item.platform,
    final_price_fen: item.final_price_fen,
    card: list(`synthetic-replay-${cardId}`, [item]),
  };
}

export function fixture(match?: ResultsDeps['match']) {
  const baseIntentDeps = intentKit().deps;
  const ctx: ToolContext = {
    subject: request('').input.caller,
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    signal: new AbortController().signal,
    placeholders: Object.freeze({ __SYNTHETIC_LINK__: 'https://example.invalid/item' }),
  };
  const replies: ToolOutcome[] = [];
  const execute = vi.fn<OrchestratorTools['execute']>(async () => replies.shift() ?? outcome());
  const inner: OrchestratorTools = {
    execute,
    definitions: vi.fn(async () => []),
    enabledSearchPlatforms: vi.fn(async () => ['jd', 'taobao']),
    searchKeyword: vi.fn(async () => ({ cards: [], results: [] })),
  };
  let memory = createMemoryResultSetStore();
  const save = vi.fn<ResultSetStore['save']>((row) => memory.save(row));
  function storePort(): ResultSetStore {
    return {
      save,
      recordDelivered: (id, items) => memory.recordDelivered(id, items),
      latestWithProducts: (app, session) => memory.latestWithProducts(app, session),
      findDelivered: (app, session, cardId) => memory.findDelivered(app, session, cardId),
      takeOnce: (scope, slot) => memory.takeOnce(scope, slot),
    };
  }
  let store = storePort();
  const text = vi.fn<ResultsDeps['texts']['text']>(async (_app, key) => copy(key));
  const deps: ResultsDeps = {
    get store() {
      return store;
    },
    texts: { text },
    limits: { toolCalls: 4, modelRounds: 3, textCodePoints: 100, cards: 30, contentFrames: 30 },
    ...(match === undefined ? {} : { match }),
  };
  let tools = createResultsTools(inner, deps);
  let clarification = createClarification({ ...deps, tools });
  let refinement = createRefinement({ ...deps, tools });
  let references = createReferenceResolver({ store });
  let sequence = 0;
  return {
    ctx,
    deps,
    get store() {
      return store;
    },
    save,
    inner,
    execute,
    replies,
    get tools() {
      return tools;
    },
    get clarification() {
      return clarification;
    },
    get refinement() {
      return refinement;
    },
    get references() {
      return references;
    },
    quoteContext(patch: Partial<ToolCallContext> = {}): ToolCallContext {
      return { ...ctx.subject, ...ctx, appId: ctx.subject.appId, ...patch };
    },
    call(args: unknown = BASE, context = ctx, name = 'search_products') {
      sequence += 1;
      return tools.execute({ id: `synthetic-call-${sequence}`, name, args }, context);
    },
    async seed(
      id: string,
      items: readonly DeliveredProduct[],
      conditions: SearchConditions = { ...BASE, chain_id: 'synthetic-chain' },
      identity: Partial<Pick<ResultSetInput, 'appId' | 'sessionId' | 'runId'>> = {},
    ) {
      await store.save({
        id,
        appId: ctx.subject.appId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        conditions,
        ...identity,
      });
      await store.recordDelivered(id, items);
    },
    async intent(value: unknown, runId = 'synthetic-intent-run') {
      const req = request(value);
      const next = { ...req, input: { ...req.input, runId } };
      const output = outputContext(runId);
      const port = createIntentPort({
        ...baseIntentDeps,
        clarification,
        continuation: { previousIntent: async () => null, ...refinement },
      });
      const result = await port.handle(next, output.ctx);
      return { ...output, result, request: next };
    },
    // Property iterations reuse every vi.fn; reset only histories, queues and the SUT state.
    reset() {
      execute.mockClear();
      save.mockClear();
      text.mockClear();
      replies.length = 0;
      sequence = 0;
      memory = createMemoryResultSetStore();
      store = storePort();
      tools = createResultsTools(inner, deps);
      clarification = createClarification({ ...deps, tools });
      refinement = createRefinement({ ...deps, tools });
      references = createReferenceResolver({ store });
    },
  };
}

import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference } from '../core/card-references.ts';
import { orchestratorLimitsDefaults } from '../core/factories.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import { createIntentPort } from '../intents/index.ts';
import type { IntentDeps, IntentRequest } from '../intents/index.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createClarification, createRefinement, createResultsTools } from './index.ts';
import type { ResultSetStore, ResultsDeps } from './index.ts';

// Synthetic only. BR-AI-08 / AC-B3-05g#3 / #11: a clarify answer continues the chain it answers
// even when the first search only asked (no product was ever delivered in the session).
const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const Q = '合成牛奶';

function input(runId: string): RunBodyInput {
  return {
    caller: {
      appId: APP,
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: SESSION,
    runId,
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成续答',
    redactedText: '合成续答' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function request(output: unknown, runId: string): IntentRequest {
  return {
    text: JSON.stringify(output),
    input: input(runId),
    proceed: {
      kind: 'proceed',
      modelText: '合成续答',
      placeholders: Object.freeze({}),
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

function productList(): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: 'synthetic-list', items: [{ product_key: 'jd:synthetic' }] },
    fallback_text: '合成商品列表',
  };
}

/** Same reference contract as the real search handler; every search finds one product. */
function searchHandler() {
  return vi.fn(async (call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => {
    const ref = cardReference(ctx, 0);
    void call;
    return {
      kind: 'ok',
      modelView: { items: [{ card_id: ref, title: '<untrusted>合成牛奶</untrusted>' }] },
      cards: [productList()],
    };
  });
}

function harness() {
  const execute = searchHandler();
  const inner: OrchestratorTools = {
    definitions: async () => [],
    execute,
    enabledSearchPlatforms: async () => ['jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const store: ResultSetStore = createMemoryResultSetStore();
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => `文案:${key}` },
    limits: orchestratorLimitsDefaults(),
  };
  const tools = createResultsTools(inner, deps);
  const clarification = createClarification({ ...deps, tools });
  const refinement = createRefinement({ ...deps, tools });
  const intentDeps: IntentDeps = {
    routes: { configured: async () => [], contract: () => bridge.routes },
    flags: { enabled: async () => true },
    tools: { registered: () => true },
    texts: deps.texts,
    trace: { calls: async () => [], record: vi.fn() },
    clarification,
    continuation: { previousIntent: async () => null, ...refinement },
  };
  const port = createIntentPort(intentDeps);

  /** A model search_products call in its own run (the core's path, through the decorator). */
  function modelSearch(args: Readonly<Record<string, unknown>>, runId: string) {
    const ctx: ToolContext = {
      subject: input(runId).caller,
      runId,
      sessionId: SESSION,
      signal: new AbortController().signal,
      placeholders: Object.freeze({}),
    };
    return tools.execute({ id: `model-${runId}`, name: 'search_products', args }, ctx);
  }

  /** The model's intent output of a later run, through the intent port. */
  async function intent(output: unknown, runId: string) {
    const cards: UnnumberedCard[] = [];
    const suggestions: unknown[] = [];
    const ctx: RunContext = {
      runId,
      sessionId: SESSION,
      signal: new AbortController().signal,
      cardsDelivered: 0,
      text: () => undefined,
      card: async (card, delivered) => {
        cards.push(card);
        delivered?.(`c${cards.length}`);
      },
      suggestions: (items) => {
        suggestions.push(...items);
      },
      toolStatus: () => undefined,
    };
    const result = await port.handle(request(output, runId), ctx);
    return { result, cards, suggestions };
  }

  return { execute, store, modelSearch, intent };
}

function noticeKeys(cards: readonly UnnumberedCard[]): unknown[] {
  return cards.filter((card) => card.type === 'notice').map((card) => card.data['text_key']);
}

async function firstSearchAsks(h: ReturnType<typeof harness>) {
  const asked = await h.modelSearch(
    { q: Q, price_min_fen: 5001, price_max_fen: 5000 },
    'search-run',
  );
  expect(asked).toMatchObject({ kind: 'ok', cards: [] });
  expect(asked.kind === 'ok' ? asked.suggestions : undefined).toHaveLength(3);
  expect(h.execute).not.toHaveBeenCalled();
  expect(await h.store.latestWithProducts(APP, SESSION)).toBeNull();
}

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] 首次搜索即追问、未出卡，下一轮 refine 再给非法价格：同链去价格检索并在卡前出 price_unrecognized', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 0 } },
    'answer-run',
  );
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0].args).toEqual({ q: Q });
  expect(out.cards.map((card) => card.type)).toEqual(['notice', 'product_list']);
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.price_unrecognized']);
  // No second ask on the same chain and slot.
  expect(out.suggestions).toEqual([]);
});

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] 首次搜索即追问、未出卡，下一轮 refine 给合法上限：沿用原搜索条件正常检索', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 6000 } },
    'answer-run',
  );
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: Q, price_min_fen: 5001, price_max_fen: 6000 },
  ]);
  expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
  expect(noticeKeys(out.cards)).toEqual([]);
});

it('[AC-B3-05g#8][BR-AI-08] 首次搜索即追问、未出卡，换平台沿用原搜索条件，只改 platforms', async () => {
  const h = harness();
  await h.modelSearch({ q: Q, price_max_fen: 0 }, 'search-run');
  expect(h.execute).not.toHaveBeenCalled();
  await h.intent({ agent_intent: 'refine', conditions: { platform: 'jd' } }, 'answer-run');
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: Q, platforms: ['jd'] }]);
});

it('[AC-B3-05g#3][BR-AI-08] 会话里既无追问链也无结果集时，refine 出 no_result，不检索', async () => {
  const h = harness();
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 6000 } },
    'answer-run',
  );
  expect(h.execute).not.toHaveBeenCalled();
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.no_result']);
  expect(out.suggestions).toHaveLength(3);
});

it('[AC-B3-05g#7][BR-PRICE-15] 再便宜点仍依赖已下发商品：只有追问链、没有已下发商品时不检索', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } }, 'run-2');
  expect(h.execute).not.toHaveBeenCalled();
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.no_result']);
});

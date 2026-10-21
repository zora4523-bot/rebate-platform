import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference, openCardCall } from '../core/card-references.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from '../core/factories.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorToolCall,
  OrchestratorTools,
  OrchestratorTrace,
  PathInput,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import { shiftCardReferences } from './references.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createRefinement, createResultsTools } from './index.ts';
import type { ResultSetStore, ResultsContinuationDeps, ResultsDeps } from './index.ts';

const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const LIST_ID = 'synthetic-list';

function input(runId = 'synthetic-run'): RunBodyInput {
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
    text: '合成牛奶',
    redactedText: '合成牛奶' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function proceed(): PathInput['proceed'] {
  return {
    kind: 'proceed',
    modelText: '合成牛奶',
    placeholders: Object.freeze({ '<num_1>': '987654321012' }),
    links: [],
    notices: [],
    untrustedInput: false,
    paramsRequested: false,
  };
}

interface Output {
  readonly ctx: RunContext;
  readonly cards: UnnumberedCard[];
  readonly statuses: string[];
}

/** A run context that numbers every written card c1, c2 … and returns the receipt. */
function output(): Output {
  const cards: UnnumberedCard[] = [];
  const statuses: string[] = [];
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: SESSION,
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: () => undefined,
    toolStatus: (tool, phase) => {
      statuses.push(`${tool}:${phase}`);
    },
    card: async (card, delivered) => {
      cards.push(card);
      delivered?.(`c${cards.length}`);
    },
    suggestions: () => undefined,
  };
  return { ctx, cards, statuses };
}

function productList(id = LIST_ID): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: id, items: [{ product_key: 'jd:synthetic' }], layout: 'list' },
    fallback_text: '合成商品列表',
  };
}

/**
 * Same reference contract as the real search_products handler (tools/search modelItems): each
 * product's card_id is cardReference(ctx, index of the product_list in this outcome's cards).
 * Without spec / price the search finds the product; with them it finds nothing.
 */
function searchHandler(found: (args: Readonly<Record<string, unknown>>) => boolean) {
  return vi.fn(async (call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => {
    const args = call.args as Readonly<Record<string, unknown>>;
    const spec = typeof args['spec'] === 'string' ? args['spec'] : null;
    const trace = { link_registrations: [], search_params: { spec, page: 1 } };
    if (!found(args)) return { kind: 'ok', modelView: { items: [] }, cards: [], trace };
    const cards = [productList()];
    const ref = cardReference(ctx, 0);
    return {
      kind: 'ok',
      modelView: { items: [{ card_id: ref, title: '<untrusted>合成牛奶</untrusted>' }] },
      cards,
      trace: { ...trace, card_sources: [{ card_id: ref, fields: { n: 1 } }] },
    };
  });
}

function inner(execute: OrchestratorTools['execute']): OrchestratorTools {
  return {
    definitions: async () => [
      { name: 'search_products', description: 'synthetic', parameters: { type: 'object' } },
      { name: 'get_rebate_quote', description: 'synthetic', parameters: { type: 'object' } },
    ],
    execute,
    enabledSearchPlatforms: async () => ['jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
}

function resultsDeps(store: ResultSetStore = createMemoryResultSetStore()): ResultsDeps {
  return {
    store,
    texts: { text: async (_app, key) => `文案:${key}` },
    limits: orchestratorLimitsDefaults(),
  };
}

function modelRound(events: Extract<ModelOutcome, { kind: 'model' }>['events']): ModelOutcome {
  return {
    kind: 'model',
    entryId: 'flash',
    model: 'synthetic-flash',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
    events,
  };
}

function toolCall(id: string, args: Readonly<Record<string, unknown>>) {
  return {
    id,
    type: 'function' as const,
    function: { name: 'search_products', arguments: JSON.stringify(args) },
  };
}

/** Runs the real core with the decorated tools; returns the tool messages the model saw. */
async function runCore(tools: OrchestratorTools, calls: readonly Record<string, unknown>[]) {
  const rounds: ModelOutcome[] = [
    modelRound([
      ...calls.map((args, index) => ({
        t: 'tool_call' as const,
        index,
        call: toolCall(`call-${index}`, args),
      })),
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]),
  ];
  const traces: OrchestratorTrace[] = [];
  const complete = vi.fn<AgentRunBodyDeps['model']['complete']>(async () => rounds.shift()!);
  const deps: AgentRunBodyDeps = {
    model: { complete },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools,
    inputCheck: { check: async () => proceed() },
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => key, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  const out = output();
  const result = await createAgentRunBody(deps)(input())(out.ctx);
  const messages = complete.mock.calls[1]?.[0].messages ?? [];
  const views = messages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
  return { result, views, cards: out.cards, traces };
}

it('[AC-B3-05g#4][BR-AI-05] 去规格放宽后，真实 core 下发里商品的 card_id 指向商品卡而非放宽提示卡', async () => {
  const execute = searchHandler((args) => args['spec'] === undefined);
  const tools = createResultsTools(inner(execute), resultsDeps());
  const run = await runCore(tools, [{ q: '合成牛奶', spec: '24盒' }]);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(run.cards.map((card) => card.type)).toEqual(['notice', 'product_list']);
  // c1 is the relaxed_spec notice, c2 the product list.
  expect(run.views).toEqual([
    {
      items: [{ card_id: 'c2', title: '<untrusted>合成牛奶</untrusted>' }],
      server_notices: ['relaxed_spec'],
    },
  ]);
  expect(run.traces[0]?.card_sources).toEqual([{ card_id: 'c2', fields: { n: 1 } }]);
  expect(JSON.stringify(run.views)).not.toContain('@card-ref:');
});

it('[AC-B3-05g#4][BR-AI-05] 两步放宽（规格、价格上限）后 card_id 越过两张提示卡', async () => {
  const execute = searchHandler(
    (args) => args['spec'] === undefined && args['price_max_fen'] === undefined,
  );
  const tools = createResultsTools(inner(execute), resultsDeps());
  const run = await runCore(tools, [{ q: '合成牛奶', spec: '24盒', price_max_fen: 5000 }]);
  expect(run.cards.map((card) => card.type)).toEqual(['notice', 'notice', 'product_list']);
  expect(run.views[0]?.['items']).toEqual([
    { card_id: 'c3', title: '<untrusted>合成牛奶</untrusted>' },
  ]);
  expect(run.traces[0]?.card_sources).toEqual([{ card_id: 'c3', fields: { n: 1 } }]);
});

it('[AC-B3-05g#3][BR-AI-05] 同链第二次非法价格去价格出卡时，card_id 指向 price_unrecognized 之后的商品卡', async () => {
  const execute = searchHandler(() => true);
  const tools = createResultsTools(inner(execute), resultsDeps());
  const invalid = { q: '合成牛奶', price_min_fen: 5000, price_max_fen: 100 };
  const run = await runCore(tools, [invalid, invalid]);
  // First call: clarify, nothing searched; second: price dropped, notice before the list.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(run.cards.map((card) => card.type)).toEqual(['notice', 'product_list']);
  expect(run.views[1]).toEqual({
    items: [{ card_id: 'c2', title: '<untrusted>合成牛奶</untrusted>' }],
    server_notices: ['price_unrecognized'],
  });
});

it('[AC-B3-05g#4][BR-AI-05] 只改写本次调用的引用：别的调用或看起来像引用的文本原样保留', () => {
  const table = Object.freeze({});
  const refs = openCardCall('call-a', table);
  const ctx = { runId: 'r', sessionId: SESSION, signal: new AbortController().signal };
  const own = cardReference({ ...ctx, placeholders: table }, 1);
  const other = Object.freeze({});
  openCardCall('call-b', other);
  const foreign = cardReference({ ...ctx, placeholders: other }, 1);
  const fake = `@card-ref:${'0'.repeat(32)}:call-a:1`;
  const view = { a: own, b: foreign, c: fake, d: [own], e: `前缀${own}` };
  const shifted = shiftCardReferences(view, { ...ctx, placeholders: table }, 2) as typeof view;
  expect(shifted.a).toBe(`${own.slice(0, own.lastIndexOf(':') + 1)}3`);
  expect(shifted.d).toEqual([shifted.a]);
  expect(shifted.b).toBe(foreign);
  expect(shifted.c).toBe(fake);
  expect(shifted.e).toBe(view.e);
  // Unchanged without an offset, and for a context the core never opened.
  expect(shiftCardReferences(view, { ...ctx, placeholders: table }, 0)).toBe(view);
  expect(shiftCardReferences(view, { ...ctx, placeholders: {} }, 2)).toEqual(view);
  refs.close();
});

function request(runId: string): PathInput & { readonly text: string } {
  return { input: input(runId), proceed: proceed(), text: '{"agent_intent":"refine"}' };
}

async function seeded(): Promise<ResultSetStore> {
  const store = createMemoryResultSetStore();
  await store.save({
    id: 'previous',
    appId: APP,
    sessionId: SESSION,
    runId: 'earlier-run',
    conditions: { q: '合成牛奶', chain_id: 'synthetic-chain' },
  });
  await store.recordDelivered('previous', [
    {
      card_id: 'c7',
      product_key: 'jd:synthetic',
      platform: 'jd',
      final_price_fen: 2990,
      card: productList('previous'),
    },
  ]);
  return store;
}

function continuation(
  execute: OrchestratorTools['execute'],
  store: ResultSetStore,
  toolDisplay?: (app: string, tool: string, phase: string) => Promise<string>,
) {
  const deps = resultsDeps(store);
  const tools = createResultsTools(inner(execute), deps);
  const texts = toolDisplay === undefined ? deps.texts : { ...deps.texts, toolDisplay };
  const full: ResultsContinuationDeps = { ...deps, texts, tools };
  return createRefinement(full);
}

it.each([
  ['再便宜点', { agent_intent: 'refine', conditions: { cheaper: true } }],
  ['换一批', { agent_intent: 'refine', conditions: { next_batch: true } }],
  ['换平台', { agent_intent: 'refine', conditions: { platform: 'jd' } }],
] as const)(
  '[AC-B3-05g#7][AC-B3-05g#8][BR-AI-05] %s 的服务端检索在自己的引用作用域里执行，真实 handler 能签发引用并出卡',
  async (_label, intent) => {
    const execute = searchHandler(() => true);
    const out = output();
    const refinement = continuation(execute, await seeded());
    const result = await refinement.run(intent, request('refine-run'), out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(execute.mock.results[0]?.value).resolves.toMatchObject({ kind: 'ok' });
    expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
    // The run's own placeholders reach the tool through a fresh per-call table.
    const ctx = execute.mock.calls[0]?.[1];
    expect(ctx?.placeholders).toEqual(proceed().placeholders);
    // The scope is closed once the call is settled.
    expect(() => cardReference(ctx!, 0)).toThrow(/settled/u);
  },
);

it('[AC-B3-05g#1][BR-AI-05] 第 N 个经 get_rebate_quote 取数时同样有引用作用域，报价卡照常下发', async () => {
  const quote = productList('quote');
  const execute = vi.fn(
    async (call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => ({
      kind: 'ok',
      modelView: { products: [{ card_id: cardReference(ctx, 0) }], name: call.name },
      cards: [quote],
    }),
  );
  const out = output();
  const refinement = continuation(execute, await seeded());
  const result = await refinement.run(
    { agent_intent: 'ref_ordinal', ordinal: 1 },
    request('ordinal-run'),
    out.ctx,
  );
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    name: 'get_rebate_quote',
    args: { ref_ordinal: 1 },
  });
  expect(out.cards).toEqual([quote]);
});

it.each([
  ['failed', { kind: 'failed', modelView: { error: 'tool_failed' } }],
  ['thrown', null],
] as const)(
  '[AC-B3-05g#7][BR-AI-05] 服务端检索失败（%s）不静默结束：tool.status failed + 警示 notice',
  async (_label, reply) => {
    const execute = vi.fn(async (): Promise<ToolOutcome> => {
      if (reply === null) throw new Error('synthetic failure');
      return reply;
    });
    const out = output();
    const display = vi.fn(async (_app: string, tool: string, phase: string) => `${tool}/${phase}`);
    const refinement = continuation(execute, await seeded(), display);
    const result = await refinement.run(
      { agent_intent: 'refine', conditions: { next_batch: true } },
      request('failing-run'),
      out.ctx,
    );
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(out.statuses).toEqual(['search_products:start', 'search_products:failed']);
    expect(out.cards).toEqual([
      {
        type: 'notice',
        schema_version: 1,
        data: { level: 'warn', text_key: 'error.50302', actions: [] },
        fallback_text: '文案:error.50302',
      },
    ]);
  },
);

it('[AC-B3-05g#1][BR-AI-05] 第 N 个报价失败时出 50303 警示 notice，不静默结束', async () => {
  const execute = vi.fn(async (): Promise<ToolOutcome> => ({
    kind: 'failed',
    modelView: { error: 'tool_failed' },
  }));
  const out = output();
  const refinement = continuation(execute, await seeded());
  await refinement.run({ agent_intent: 'ref_ordinal', ordinal: 1 }, request('q-run'), out.ctx);
  expect(out.statuses).toEqual([]);
  expect(out.cards.map((card) => card.data)).toEqual([
    { level: 'warn', text_key: 'error.50303', actions: [] },
  ]);
});

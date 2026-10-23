// B3-03p §9 items 1–4 · BR-AI-05: delivery receipts beyond the model's tool calls. Product cards
// that go out through the guarded context the core hands to the no-model degraded path, the intent
// port's follow-ups (再便宜点 / 换一批) and the deterministic link path are recorded like the model
// path's (their own card_ids, delivery order; cut by the limits or cancelled: nothing; notices and
// list containers: never), so the next round's 「第 N 个」 and card_id address them. The product
// inside a rebate_quote card is quotable again by its card_id, but 「第 N 个」 keeps addressing the
// latest result set with a product_list. A failed record never changes the run.
import { expect, it, vi } from 'vitest';
import {
  createAgentRunBody,
  type AgentRunBodyDeps,
  type InputCheckPort,
  type IntentPort,
  type OrchestratorTools,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createDegradedPath } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/index.ts';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import {
  createMemoryResultSetStore,
  createReferenceResolver,
  createRefinement,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { LinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import {
  deliveredProducts,
  inputFor,
  noticeCard,
  proceedOf,
  receiptContext,
  receipts,
  syntheticBody,
  type RecordDelivered,
  type Row,
} from '../stream-model-prereq/kit.ts';
import {
  APP_A,
  LIMITS,
  RUN_TEXTS,
  TEXTS,
  deliveredOf,
  keywordTools,
  lookupContext,
  pricedList,
  quoteCard,
  seed,
} from './kit.ts';

type Complete = AgentRunBodyDeps['model']['complete'];

/** The two ways a run reaches the no-model keyword search before any delivery. */
function degradeVia(trigger: 'route_no_model' | 'models_failed'): Partial<AgentRunBodyDeps> {
  if (trigger === 'route_no_model') return { prompt: { current: async () => null } };
  const complete = vi.fn<Complete>(async () => ({
    kind: 'degraded',
    reason: 'models_failed',
    attempts: [],
  }));
  return { model: { complete } };
}

function degradedPath(tools: OrchestratorTools) {
  return createDegradedPath({ tools, texts: TEXTS, errorMsg: async () => '合成错误文案' });
}

it.each(['route_no_model', 'models_failed'] as const)(
  '[AC-B3-03p#1][BR-AI-05][BR-AI-14] 降级关键词搜索（%s）下发的商品卡按下发顺序经 recordDelivered 记实际 card_id；下一轮「第 N 个」与 card_id 解析到这批卡而不是上一个结果集；notice 与列表容器不记',
  async (trigger) => {
    const value = inputFor(APP_A);
    const store = createMemoryResultSetStore();
    await seed(store, value, 'synthetic-set-earlier', [
      deliveredOf('c2', 'tb:synthetic-old-a', 3000),
      deliveredOf('c3', 'tb:synthetic-old-b', 2500),
    ]);
    const recordDelivered = vi.fn<RecordDelivered>((id, items) => store.recordDelivered(id, items));
    const batch = pricedList('synthetic-set-degraded', [
      ['tb:synthetic-d1', 1800],
      ['tb:synthetic-d2', 1600],
    ]);
    const { tools, searchKeyword } = keywordTools(store, [noticeCard(), batch]);
    const out = receiptContext({ runId: value.runId, sessionId: value.sessionId, firstNo: 10 });
    const result = await createAgentRunBody(
      syntheticBody(tools, [], {
        degraded: degradedPath(tools),
        results: { ...store, recordDelivered },
        ...degradeVia(trigger),
      }),
    )(value)(out.ctx);

    expect(result).toEqual({ kind: 'done', finishReason: 'fallback' });
    expect(searchKeyword).toHaveBeenCalledTimes(1);
    // notice c10, list c11 (+ c12, c13): products keep their own ids, frame first.
    expect(out.frames.map((frame) => [frame.type, frame.card_id])).toEqual([
      ['notice', 'c10'],
      ['product_list', 'c11'],
    ]);
    const shown = deliveredProducts(out.frames);
    expect(shown.map((item) => item.card_id)).toEqual(['c12', 'c13']);
    expect(receipts(recordDelivered)).toEqual(shown);

    const resolver = createReferenceResolver({ store });
    const next = lookupContext(value);
    expect(await resolver.resolve({ ref_ordinal: 1 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-d1',
    });
    expect(await resolver.resolve({ ref_ordinal: 2 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-d2',
    });
    expect(await resolver.resolve({ ref_ordinal: 3 }, next)).toEqual({ kind: 'clarify' });
    for (const [cardId, productKey] of [
      ['c12', 'tb:synthetic-d1'],
      ['c13', 'tb:synthetic-d2'],
      ['c2', 'tb:synthetic-old-a'],
    ] as const) {
      expect(await resolver.resolve({ card_id: cardId }, next), cardId).toEqual({
        kind: 'product',
        productKey,
      });
    }
    for (const cardId of ['c10', 'c11']) {
      expect(await resolver.resolve({ card_id: cardId }, next), cardId).toEqual({
        kind: 'invalid_args',
      });
    }
  },
);

it.each(['limit', 'cancel'] as const)(
  '[AC-B3-03p#2][BR-AI-05] 降级路径：被卡片上限截掉或取消（%s）未写出的商品列表不记；之前已写出的照记',
  async (mode) => {
    const value = inputFor(APP_A);
    const recordDelivered = vi.fn<RecordDelivered>(async () => undefined);
    const store = createMemoryResultSetStore();
    const { tools } = keywordTools(store, [
      pricedList('synthetic-set-1', [
        ['tb:synthetic-a', 1000],
        ['tb:synthetic-b', 1000],
      ]),
      pricedList('synthetic-set-2', [
        ['tb:synthetic-c', 1000],
        ['tb:synthetic-d', 1000],
      ]),
    ]);
    const out = receiptContext({
      runId: value.runId,
      sessionId: value.sessionId,
      ...(mode === 'cancel'
        ? { drop: (card: UnnumberedCard) => card.data['result_set_id'] === 'synthetic-set-2' }
        : {}),
    });
    // 1 + 2 cards fit in 4; the second list (3 more) is never split.
    const limits = { ...LIMITS, cards: mode === 'limit' ? 4 : LIMITS.cards };
    const result = await createAgentRunBody(
      syntheticBody(tools, [], {
        degraded: degradedPath(tools),
        results: { recordDelivered },
        prompt: { current: async () => null },
        limits,
      }),
    )(value)(out.ctx);

    expect(result).toEqual({ kind: 'done', finishReason: mode === 'limit' ? 'limit' : 'stop' });
    expect(deliveredProducts(out.frames).map((item) => item.resultSetId)).toEqual([
      'synthetic-set-1',
      'synthetic-set-1',
    ]);
    expect(receipts(recordDelivered)).toEqual([
      expect.objectContaining({
        resultSetId: 'synthetic-set-1',
        card_id: 'c2',
        product_key: 'tb:synthetic-a',
      }),
      expect.objectContaining({
        resultSetId: 'synthetic-set-1',
        card_id: 'c3',
        product_key: 'tb:synthetic-b',
      }),
    ]);
    expect(recordDelivered.mock.calls.map(([id]) => id)).not.toContain('synthetic-set-2');
  },
);

it.each(['reject', 'throw'] as const)(
  '[AC-B3-03p#3][BR-AI-05] 降级路径记回执失败（%s）只丢弃这次记录：本轮下发的卡片、文本与结果都不变',
  async (mode) => {
    const value = inputFor(APP_A);
    const cards = () => [
      noticeCard(),
      pricedList('synthetic-set-1', [
        ['tb:synthetic-a', 1000],
        ['tb:synthetic-b', 900],
      ]),
      pricedList('synthetic-set-2', [['tb:synthetic-c', 800]]),
    ];
    const run = async (patch: Partial<AgentRunBodyDeps>) => {
      const { tools } = keywordTools(createMemoryResultSetStore(), cards());
      const out = receiptContext({ runId: value.runId, sessionId: value.sessionId });
      const result = await createAgentRunBody(
        syntheticBody(tools, [], {
          degraded: degradedPath(tools),
          prompt: { current: async () => null },
          ...patch,
        }),
      )(value)(out.ctx);
      return { result, frames: out.frames, texts: out.texts };
    };
    const failing = vi.fn<RecordDelivered>(
      mode === 'reject'
        ? async () => {
            throw new Error('synthetic receipt store unavailable');
          }
        : () => {
            throw new Error('synthetic receipt store unavailable');
          },
    );

    const baseline = await run({});
    const failed = await run({ results: { recordDelivered: failing } });
    expect(failing.mock.calls.map(([id]) => id)).toEqual(['synthetic-set-1', 'synthetic-set-2']);
    expect(failed).toEqual(baseline);
    expect(failed.result).toEqual({ kind: 'done', finishReason: 'fallback' });
    expect(failed.frames.map((frame) => frame.type)).toEqual([
      'notice',
      'product_list',
      'product_list',
    ]);
    expect(failed.texts).toEqual(['固定文案:agent.degraded']);
  },
);

it.each([
  ['再便宜点', { cheaper: true }, { price_max_fen: 1999, sort: 'final_price_asc', page: 1 }],
  ['换一批', { next_batch: true }, { page: 2 }],
] as const)(
  '[AC-B3-03p#4][BR-AI-05][BR-PRICE-15] 续答「%s」下发的新一批商品记回执；之后「第 N 个」指向新一批，更早一轮的 card_id 仍可引用',
  async (_label, conditions, expectedArgs) => {
    const value = inputFor(APP_A, '合成续答');
    const store = createMemoryResultSetStore();
    await seed(store, value, 'synthetic-set-0', [
      deliveredOf('c2', 'tb:synthetic-a', 3000),
      deliveredOf('c3', 'tb:synthetic-b', 2000),
    ]);
    const recordDelivered = vi.fn<RecordDelivered>((id, items) => store.recordDelivered(id, items));
    const execute = vi.fn<OrchestratorTools['execute']>(async (_call, ctx) => {
      // The results decorator saves the refined search's conditions before its cards go out.
      await store.save({
        id: 'synthetic-set-1',
        appId: ctx.subject.appId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        conditions: { q: '合成保温杯', chain_id: 'synthetic-chain' },
      });
      return {
        kind: 'ok',
        modelView: { items: [] },
        cards: [
          pricedList('synthetic-set-1', [
            ['tb:synthetic-n1', 1500],
            ['tb:synthetic-n2', 1200],
          ]),
        ],
      };
    });
    const tools: OrchestratorTools = {
      definitions: async () => [],
      execute,
      enabledSearchPlatforms: async () => [],
      searchKeyword: async () => ({ results: [], cards: [] }),
    };
    const refinement = createRefinement({ store, texts: TEXTS, limits: LIMITS, tools });
    const intents: IntentPort = {
      handle: (request, ctx) =>
        refinement.run({ agent_intent: 'refine', conditions }, request, ctx),
    };
    const out = receiptContext({ runId: value.runId, sessionId: value.sessionId, firstNo: 10 });
    const result = await createAgentRunBody(
      syntheticBody(tools, [{ text: JSON.stringify({ agent_intent: 'refine', conditions }) }], {
        intents,
        results: { ...store, recordDelivered },
      }),
    )(value)(out.ctx);

    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      name: 'search_products',
      args: expect.objectContaining(expectedArgs),
    });
    const shown = deliveredProducts(out.frames);
    expect(shown.map((item) => [item.card_id, item.product_key])).toEqual([
      ['c11', 'tb:synthetic-n1'],
      ['c12', 'tb:synthetic-n2'],
    ]);
    expect(receipts(recordDelivered)).toEqual(shown);

    const resolver = createReferenceResolver({ store });
    const next = lookupContext(value);
    expect(await resolver.resolve({ ref_ordinal: 1 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-n1',
    });
    expect(await resolver.resolve({ ref_ordinal: 2 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-n2',
    });
    expect(await resolver.resolve({ ref_ordinal: 3 }, next)).toEqual({ kind: 'clarify' });
    expect(await resolver.resolve({ card_id: 'c12' }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-n2',
    });
    expect(await resolver.resolve({ card_id: 'c2' }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-a',
    });
    expect(await resolver.resolve({ card_id: 'c10' }, next)).toEqual({ kind: 'invalid_args' });
  },
);

it.each([
  ['url', 'https://example.invalid/item/synthetic-1', 'https://example.invalid/item/synthetic-2'],
  ['tpwd', '￥Synthetic01￥', '￥Synthetic02￥'],
] as const)(
  '[AC-B3-03p#5][BR-AI-05][BR-AI-04] 确定性路径（%s）下发的报价卡内商品按其 card_id 记回执，下一轮可按该 card_id 再报价；「第 N 个」仍指向最近的商品列表；取消未写出的报价卡不记',
  async (kind, firstRaw, secondRaw) => {
    const value = inputFor(APP_A, `${firstRaw} ${secondRaw}`);
    const store = createMemoryResultSetStore();
    await seed(store, value, 'synthetic-set-0', [
      deliveredOf('c2', 'tb:synthetic-a', 3000),
      deliveredOf('c3', 'tb:synthetic-b', 2000),
    ]);
    const inputCheck: InputCheckPort = {
      check: async (input) => ({
        ...proceedOf(input.text),
        links: [
          { kind, raw: firstRaw, index: 0 },
          { kind, raw: secondRaw, index: firstRaw.length + 1 },
        ],
      }),
    };
    const run = vi.fn<LinkQuoteRunner['run']>(async (candidate) => ({
      kind: 'ok',
      modelView: {},
      cards: [quoteCard(candidate.raw === firstRaw ? 'tb:synthetic-q1' : 'tb:synthetic-q2', 1500)],
    }));
    const out = receiptContext({
      runId: value.runId,
      sessionId: value.sessionId,
      firstNo: 10,
      // The run is cancelled when the second quote is about to be written.
      drop: (card) =>
        card.type === 'rebate_quote' &&
        (card.data['product'] as Row)['product_key'] === 'tb:synthetic-q2',
    });
    const { tools } = keywordTools(store, []);
    const result = await createAgentRunBody(
      syntheticBody(tools, [], {
        inputCheck,
        deterministic: createDeterministicPath({ quotes: { run }, texts: RUN_TEXTS }),
        results: store,
      }),
    )(value)(out.ctx);

    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run).toHaveBeenCalledTimes(2);
    // rebate_quote frame c10, its product c11 (04 §8.2); the second quote never got a number.
    expect(out.frames.map((frame) => [frame.type, frame.card_id])).toEqual([
      ['rebate_quote', 'c10'],
    ]);
    expect((out.frames[0]?.data['product'] as Row | undefined)?.['card_id']).toBe('c11');

    const resolver = createReferenceResolver({ store });
    const next = lookupContext(value);
    expect(await resolver.resolve({ card_id: 'c11' }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-q1',
    });
    // 「第 N 个」: still the latest result set with a product_list, unchanged by the quote.
    expect(await resolver.resolve({ ref_ordinal: 1 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-a',
    });
    expect(await resolver.resolve({ ref_ordinal: 2 }, next)).toEqual({
      kind: 'product',
      productKey: 'tb:synthetic-b',
    });
    expect(await resolver.resolve({ ref_ordinal: 3 }, next)).toEqual({ kind: 'clarify' });
    // The cancelled quote was never written: nothing under the ids it would have taken.
    for (const cardId of ['c12', 'c13']) {
      expect(await resolver.resolve({ card_id: cardId }, next), cardId).toEqual({
        kind: 'invalid_args',
      });
    }
    // Another session of the same app sees none of it.
    const other = lookupContext(value, 'synthetic-other');
    expect(await resolver.resolve({ card_id: 'c11' }, other)).toEqual({ kind: 'invalid_args' });
  },
);

it('[AC-B3-03p#6][BR-AI-05] 模型路径 get_rebate_quote 下发的报价卡内商品同样记回执：下一轮按其 card_id 可再报价，「第 N 个」不改指向', async () => {
  const value = inputFor(APP_A);
  const store = createMemoryResultSetStore();
  await seed(store, value, 'synthetic-set-0', [
    deliveredOf('c2', 'tb:synthetic-a', 3000),
    deliveredOf('c3', 'tb:synthetic-b', 2000),
  ]);
  const execute = vi.fn<OrchestratorTools['execute']>(async () => ({
    kind: 'ok',
    modelView: { products: [] },
    cards: [quoteCard('tb:synthetic-q', 1500)],
  }));
  const tools: OrchestratorTools = {
    definitions: async () => [
      {
        name: 'get_rebate_quote',
        description: '合成报价工具',
        parameters: {
          type: 'object',
          properties: { card_id: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ],
    execute,
    enabledSearchPlatforms: async () => [],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const out = receiptContext({ runId: value.runId, sessionId: value.sessionId, firstNo: 10 });
  const result = await createAgentRunBody(
    syntheticBody(
      tools,
      [{ calls: [{ name: 'get_rebate_quote', args: { card_id: 'c2' } }] }, { text: '好的。' }],
      { results: store },
    ),
  )(value)(out.ctx);

  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(out.frames.map((frame) => [frame.type, frame.card_id])).toEqual([['rebate_quote', 'c10']]);

  const resolver = createReferenceResolver({ store });
  const next = lookupContext(value);
  expect(await resolver.resolve({ card_id: 'c11' }, next)).toEqual({
    kind: 'product',
    productKey: 'tb:synthetic-q',
  });
  expect(await resolver.resolve({ ref_ordinal: 1 }, next)).toEqual({
    kind: 'product',
    productKey: 'tb:synthetic-a',
  });
  expect(await resolver.resolve({ ref_ordinal: 3 }, next)).toEqual({ kind: 'clarify' });
});

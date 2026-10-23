// B3-03n §9 item 1 · BR-AI-05: the core's delivery receipts (followup 44). After a successful tool
// call, every written product_list goes to the body's result-set port: its embedded product cards
// with their own delivered card_id, in delivery order; nothing for a card cut by the output limits
// or never written because the run was cancelled; notices are not product cards. Then the same
// session resolves get_rebate_quote's card_id / ref_ordinal (「第 N 个」) to that product.
import { expect, it, vi } from 'vitest';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createMemoryResultSetStore,
  createReferenceResolver,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { input } from '../orchestrator-core/kit.ts';
import {
  deliveredProducts,
  list,
  noticeCard,
  receiptContext,
  receipts,
  searchTools,
  syntheticBody,
  type RecordDelivered,
  type Round,
} from './kit.ts';

const SEARCH: Round[] = [
  { calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] },
  { text: '好的。' },
];

function run(...args: Parameters<typeof syntheticBody>) {
  const value = input();
  const out = receiptContext({ runId: value.runId, sessionId: value.sessionId });
  return { out, result: createAgentRunBody(syntheticBody(...args))(value)(out.ctx) };
}

it('[AC-B3-03n#1][BR-AI-05] core 下发商品卡后按下发顺序经结果集端口 recordDelivered 记下实际 card_id；notice 与列表容器不记', async () => {
  const recordDelivered = vi.fn<RecordDelivered>(async () => undefined);
  const { tools } = searchTools([
    {
      kind: 'ok',
      modelView: { items: [] },
      cards: [
        noticeCard(),
        list('synthetic-set-1', ['tb:synthetic-a', 'tb:synthetic-b']),
        list('synthetic-set-2', ['tb:synthetic-c']),
      ],
    },
  ]);
  const { out, result } = run(tools, SEARCH, { results: { recordDelivered } });
  expect(await result).toEqual({ kind: 'done', finishReason: 'stop' });

  // notice c1, list c2 (+ c3, c4), list c5 (+ c6): the products' own ids, frame first.
  expect(out.frames.map((frame) => frame.card_id)).toEqual(['c1', 'c2', 'c5']);
  const shown = deliveredProducts(out.frames);
  expect(shown.map((item) => item.card_id)).toEqual(['c3', 'c4', 'c6']);
  expect(receipts(recordDelivered)).toEqual(shown);
  expect(receipts(recordDelivered)).toEqual([
    {
      resultSetId: 'synthetic-set-1',
      card_id: 'c3',
      product_key: 'tb:synthetic-a',
      platform: 'taobao',
      final_price_fen: 1000,
    },
    {
      resultSetId: 'synthetic-set-1',
      card_id: 'c4',
      product_key: 'tb:synthetic-b',
      platform: 'taobao',
      final_price_fen: 1000,
    },
    {
      resultSetId: 'synthetic-set-2',
      card_id: 'c6',
      product_key: 'tb:synthetic-c',
      platform: 'taobao',
      final_price_fen: 1000,
    },
  ]);
  // The first list is recorded before the second (delivery order across calls too).
  const order = recordDelivered.mock.calls.map(([id]) => id);
  expect(order.indexOf('synthetic-set-1')).toBeLessThan(order.indexOf('synthetic-set-2'));
});

it('[AC-B3-03n#1][BR-AI-05] 被卡片上限截掉的商品列表不记；已写出的照记', async () => {
  const recordDelivered = vi.fn<RecordDelivered>(async () => undefined);
  const { tools } = searchTools([
    {
      kind: 'ok',
      modelView: { items: [] },
      cards: [
        list('synthetic-set-1', ['tb:synthetic-a', 'tb:synthetic-b']),
        list('synthetic-set-2', ['tb:synthetic-c', 'tb:synthetic-d']),
      ],
    },
  ]);
  const limits = {
    toolCalls: 4,
    modelRounds: 3,
    textCodePoints: 20_000,
    cards: 4,
    contentFrames: 400,
  };
  const { out, result } = run(tools, SEARCH, { results: { recordDelivered }, limits });
  expect(await result).toEqual({ kind: 'done', finishReason: 'limit' });
  // 1 + 2 cards fit; the second list (3 more) never goes out and is not split.
  expect(out.frames.map((frame) => frame.data['result_set_id'])).toEqual(['synthetic-set-1']);
  expect(receipts(recordDelivered)).toEqual([
    expect.objectContaining({ resultSetId: 'synthetic-set-1', card_id: 'c2' }),
    expect.objectContaining({ resultSetId: 'synthetic-set-1', card_id: 'c3' }),
  ]);
  expect(recordDelivered.mock.calls.map(([id]) => id)).not.toContain('synthetic-set-2');
});

it('[AC-B3-03n#1][BR-AI-05] 取消后未写出的商品列表不记；取消前已写出的照记', async () => {
  const recordDelivered = vi.fn<RecordDelivered>(async () => undefined);
  const { tools } = searchTools([
    {
      kind: 'ok',
      modelView: { items: [] },
      cards: [
        list('synthetic-set-1', ['tb:synthetic-a']),
        list('synthetic-set-2', ['tb:synthetic-b']),
      ],
    },
  ]);
  const value = input();
  const out = receiptContext({
    runId: value.runId,
    sessionId: value.sessionId,
    drop: (card) => card.data['result_set_id'] === 'synthetic-set-2',
  });
  const result = await createAgentRunBody(
    syntheticBody(tools, SEARCH, { results: { recordDelivered } }),
  )(value)(out.ctx);
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(out.controller.signal.aborted).toBe(true);
  expect(deliveredProducts(out.frames).map((item) => item.card_id)).toEqual(['c2']);
  expect(receipts(recordDelivered)).toEqual([
    expect.objectContaining({
      resultSetId: 'synthetic-set-1',
      card_id: 'c2',
      product_key: 'tb:synthetic-a',
    }),
  ]);
  expect(recordDelivered.mock.calls.map(([id]) => id)).not.toContain('synthetic-set-2');
});

it('[AC-B3-03n#1][BR-AI-05] 回执写进共享结果集后，同会话按 card_id（含更早轮次）与「第 N 个」解析到对应商品；notice / 列表容器 / 越界序号不解析', async () => {
  const value = input();
  const store = createMemoryResultSetStore();
  const save = (id: string, q: string) =>
    store.save({
      id,
      appId: value.caller.appId,
      sessionId: value.sessionId,
      runId: value.runId,
      conditions: { q, chain_id: 'synthetic-chain' },
    });
  // The results decorator saves each list's conditions before the core delivers it (B3-05g).
  const { tools } = searchTools(
    [
      {
        kind: 'ok',
        modelView: { items: [] },
        cards: [noticeCard(), list('synthetic-set-1', ['tb:synthetic-a', 'tb:synthetic-b'])],
      },
      {
        kind: 'ok',
        modelView: { items: [] },
        cards: [list('synthetic-set-2', ['tb:synthetic-c', 'tb:synthetic-d'])],
      },
    ],
    async (index) => save(index === 0 ? 'synthetic-set-1' : 'synthetic-set-2', `合成${index}`),
  );
  const out = receiptContext({ runId: value.runId, sessionId: value.sessionId });
  const result = await createAgentRunBody(
    syntheticBody(
      tools,
      [
        { calls: [{ name: 'search_products', args: { q: '合成0' } }] },
        { calls: [{ name: 'search_products', args: { q: '合成1' } }] },
        { text: '好的。' },
      ],
      { results: store },
    ),
  )(value)(out.ctx);
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  const shown = deliveredProducts(out.frames);
  expect(shown.map((item) => [item.card_id, item.product_key])).toEqual([
    ['c3', 'tb:synthetic-a'],
    ['c4', 'tb:synthetic-b'],
    ['c6', 'tb:synthetic-c'],
    ['c7', 'tb:synthetic-d'],
  ]);

  const resolver = createReferenceResolver({ store });
  const context: ToolCallContext = {
    appId: value.caller.appId,
    userId: value.caller.userId,
    deviceId: value.caller.deviceId,
    phoneBound: value.caller.phoneBound,
    runId: 'synthetic-next-run',
    sessionId: value.sessionId,
    signal: new AbortController().signal,
    placeholders: {},
  };
  for (const [cardId, productKey] of [
    ['c3', 'tb:synthetic-a'],
    ['c4', 'tb:synthetic-b'],
    ['c7', 'tb:synthetic-d'],
  ] as const) {
    expect(await resolver.resolve({ card_id: cardId }, context)).toEqual({
      kind: 'product',
      productKey,
    });
  }
  // 「第 N 个」 addresses the latest result set with products, in delivery order.
  expect(await resolver.resolve({ ref_ordinal: 1 }, context)).toEqual({
    kind: 'product',
    productKey: 'tb:synthetic-c',
  });
  expect(await resolver.resolve({ ref_ordinal: 2 }, context)).toEqual({
    kind: 'product',
    productKey: 'tb:synthetic-d',
  });
  expect(await resolver.resolve({ ref_ordinal: 3 }, context)).toEqual({ kind: 'clarify' });
  for (const cardId of ['c1', 'c2', 'c5']) {
    expect(await resolver.resolve({ card_id: cardId }, context)).toEqual({ kind: 'invalid_args' });
  }
  // Another session of the same app sees none of it.
  expect(
    await resolver.resolve({ card_id: 'c3' }, { ...context, sessionId: 'synthetic-other' }),
  ).toEqual({ kind: 'invalid_args' });
});

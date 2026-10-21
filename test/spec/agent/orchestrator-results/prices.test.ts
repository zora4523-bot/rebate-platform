import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { priceRangeInvalidView } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import {
  cards,
  expectSafeModelView,
  fixture,
  noticeKeys,
  outcome,
  product,
  request,
} from './kit.ts';

it.each([
  { price_min_fen: 0 },
  { price_max_fen: 0 },
  { price_min_fen: -1 },
  { price_max_fen: -1 },
  { price_min_fen: 10_000_001 },
  { price_max_fen: 10_000_001 },
  { price_min_fen: 5001, price_max_fen: 5000 },
  { price_min_fen: 1.5 },
  { price_max_fen: 1.5 },
])('[AC-B3-05g#3][BR-AI-08] 非法价格 %j 首次不检索，第二次去价格并在卡前提示', async (prices) => {
  const h = fixture();
  const args = { q: '合成商品', platforms: ['jd'], sort: 'sales_desc', ...prices };
  const first = await h.call(args);
  expectSafeModelView(first.modelView);
  expect(h.execute).not.toHaveBeenCalled();
  expect(cards(first)).toEqual([]);
  expect(first).toMatchObject({ suggestions: await h.clarification.options('price') });
  if (first.kind === 'ok') expect(first.suggestions).toHaveLength(3);
  h.replies.push(outcome([product()], 'fallback', null, 1));
  const second = await h.call(args);
  expectSafeModelView(second.modelView);
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0].args).toEqual({
    q: '合成商品',
    platforms: ['jd'],
    sort: 'sales_desc',
  });
  expect(noticeKeys(second)).toEqual(['agent.notice.price_unrecognized']);
  expect(cards(second).map((c) => c.type)).toEqual(['notice', 'product_list']);
  expect(second.kind === 'ok' ? (second.suggestions ?? []) : null).toEqual([]);
});

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] 直接搜索的非法价格跨 run 续答，同链只追问一次', async () => {
  const h = fixture();
  const args = { q: '合成商品', platforms: ['jd'], price_min_fen: 5001, price_max_fen: 5000 };
  const first = await h.call(args);
  expect(first).toMatchObject({
    kind: 'ok',
    cards: [],
    suggestions: await h.clarification.options('price'),
  });
  expect(first.kind === 'ok' ? first.suggestions : null).toHaveLength(3);
  expectSafeModelView(first.modelView);
  expect(h.execute).not.toHaveBeenCalled();
  const req = request({ agent_intent: 'clarify', slot: 'price' });
  const firstScope = await h.clarification.scope(req);
  const nextCtx = { ...h.ctx, runId: 'answer-run' };
  h.replies.push(outcome([product()], 'answer', null, 1));
  // No new search intent or changed query: this call answers the pending price question.
  const second = await h.call(args, nextCtx);
  expect(h.execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: 'search_products', args: { q: args.q, platforms: ['jd'] } }),
    nextCtx,
  );
  expect(noticeKeys(second)).toEqual(['agent.notice.price_unrecognized']);
  expect(cards(second).map((card) => card.type)).toEqual(['notice', 'product_list']);
  expect(second.kind === 'ok' ? (second.suggestions ?? []) : null).toEqual([]);
  expectSafeModelView(second.modelView);
  expect(h.save.mock.calls.at(-1)?.[0].conditions.chain_id).toBe(firstScope.chainId);
  expect(
    await h.clarification.scope({ ...req, input: { ...req.input, runId: nextCtx.runId } }),
  ).toEqual(firstScope);
});

it('[AC-B3-05g#3][BR-AI-08] 内层 price_range_invalid 也只追问一次，再出现时丢价格重查', async () => {
  const h = fixture();
  const invalid = { kind: 'ok' as const, modelView: priceRangeInvalidView(), cards: [] };
  h.replies.push(invalid);
  const first = await h.call({ q: '合成商品', price_min_fen: 100, price_max_fen: 5000 });
  expectSafeModelView(first.modelView);
  expect(cards(first)).toEqual([]);
  expect(first).toMatchObject({ suggestions: await h.clarification.options('price') });
  expect(h.execute).toHaveBeenCalledTimes(1);
  h.replies.push(invalid, outcome([product()], 'fallback', null, 1));
  const second = await h.call({ q: '合成商品', price_min_fen: 100, price_max_fen: 5000 });
  expectSafeModelView(second.modelView);
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect(h.execute.mock.calls[2]?.[0].args).toEqual({ q: '合成商品' });
  expect(noticeKeys(second)).toEqual(['agent.notice.price_unrecognized']);
  expect(cards(second).map((c) => c.type)).toEqual(['notice', 'product_list']);
});

it.each([1, 10_000_000])(
  '[AC-B3-05g#3][BR-AI-08] 合法边界 %i 分和 min=max 不追问',
  async (price) => {
    const h = fixture();
    h.replies.push(outcome([product('jd:boundary', price)], 'boundary', null, 1));
    const args = { q: '合成商品', price_min_fen: price, price_max_fen: price };
    const result = await h.call(args);
    expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([args]);
    expect(cards(result)).toHaveLength(1);
    expect(result.kind === 'ok' ? (result.suggestions ?? []) : null).toEqual([]);
  },
);

it('[AC-B3-05g#3][BR-AI-08] 属性：整数价格区间只在合法闭区间内才交给搜索端口', async () => {
  const h = fixture();
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: -2, max: 10_000_002 }),
      fc.integer({ min: -2, max: 10_000_002 }),
      async (min, max) => {
        h.reset();
        h.replies.push(outcome([product('jd:property', min)], 'property', null, 1));
        const result = await h.call({ q: '合成商品', price_min_fen: min, price_max_fen: max });
        const valid = min > 0 && max <= 10_000_000 && min <= max;
        expect(h.execute).toHaveBeenCalledTimes(valid ? 1 : 0);
        expect(cards(result)).toHaveLength(valid ? 1 : 0);
        if (!valid) {
          expect(result).toMatchObject({ suggestions: await h.clarification.options('price') });
        }
      },
    ),
    propParams(),
  );
}, 60_000);

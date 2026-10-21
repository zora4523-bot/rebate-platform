import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { priceRangeInvalidView } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { cards, fixture, noticeKeys, outcome, product } from './kit.ts';

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
  expect(h.execute).not.toHaveBeenCalled();
  expect(cards(first)).toEqual([]);
  expect(first).toMatchObject({ suggestions: await h.clarification.options('price') });
  if (first.kind === 'ok') expect(first.suggestions).toHaveLength(3);
  h.replies.push(outcome([product()], 'fallback', null, 1));
  const second = await h.call(args);
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

it('[AC-B3-05g#3][BR-AI-08] 内层 price_range_invalid 也只追问一次，再出现时丢价格重查', async () => {
  const h = fixture();
  const invalid = { kind: 'ok' as const, modelView: priceRangeInvalidView(), cards: [] };
  h.replies.push(invalid);
  const first = await h.call({ q: '合成商品', price_min_fen: 100, price_max_fen: 5000 });
  expect(cards(first)).toEqual([]);
  expect(first).toMatchObject({ suggestions: await h.clarification.options('price') });
  expect(h.execute).toHaveBeenCalledTimes(1);
  h.replies.push(invalid, outcome([product()], 'fallback', null, 1));
  const second = await h.call({ q: '合成商品', price_min_fen: 100, price_max_fen: 5000 });
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

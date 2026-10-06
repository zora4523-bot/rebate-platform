import { expect, it } from 'vitest';
import { computeFacts, gradeCase } from '../../../packages/evals/src/index.ts';
import type { TurnOutput } from '../../../packages/evals/src/index.ts';
import { card, frame, identityFields, output, sample } from '../evals-replay/fixtures.ts';
import { count, fact } from './fixtures.ts';

function product(card_id: string, link_id: string | null = null) {
  return {
    card_id,
    product_key: 'taobao:synthetic-1',
    link_id,
    price_fen: 2990,
    coupon_fen: 0,
    is_presale: true,
  };
}
function shown(type: string, data: Record<string, unknown>, card_id = 'outer'): TurnOutput {
  const out = output();
  out.frames.unshift(
    frame('card', { type, card_id, data, schema_version: 1, fallback_text: '合成卡' }),
  );
  return out;
}

it('[BR-AI-04] [AC-B3-01c-F01] 逐张核对指定卡型，商品用自身 id，订单和实时收益用帧 id', () => {
  const c = sample();
  const out = output();
  out.frames.unshift(
    frame('card', {
      type: 'product_list',
      card_id: 'list',
      data: { items: [product('p1'), product('p2')] },
    }),
    frame('card', { type: 'rebate_quote', card_id: 'quote', data: { product: product('p3') } }),
    frame('card', {
      type: 'order_status',
      card_id: 'order',
      data: { est_rebate_fen: 2990, display_status: 'PAID' },
    }),
    frame('card', {
      type: 'earnings_summary',
      card_id: 'wallet',
      data: { withdrawable_fen: 2990, credit_overdue: false, next_credit_period: null },
    }),
    frame('card', {
      type: 'earnings_summary',
      card_id: 'history',
      data: { as_of: '2026-10-06T09:00:00+08:00', actions: [] },
    }),
    card('notice'),
    frame('card', { type: 'page_guide', card_id: 'guide', data: { price_fen: 2990 } }),
  );
  out.trace.card_sources = [
    ...['p1', 'p2', 'p3'].map((card_id) => ({
      card_id,
      fields: { price_fen: 2990, coupon_fen: 0, is_presale: true },
    })),
    { card_id: 'order', fields: { display_status: 'PAID', est_rebate_fen: 2990 } },
    {
      card_id: 'wallet',
      fields: { next_credit_period: null, credit_overdue: false, withdrawable_fen: 2990 },
    },
  ];
  const before = structuredClone(out);
  expect(computeFacts(c, [out])).toEqual(fact(c.id, { card_values: count(5) }));
  expect(out).toEqual(before);
});

it.each(['product_list', 'rebate_quote', 'order_status', 'earnings_summary'])(
  '[BR-AI-04] [AC-B3-01c-F02] %s 不认错层级的 card_id',
  (type) => {
    const payload =
      type === 'product_list'
        ? { items: [product('inner')] }
        : type === 'rebate_quote'
          ? { product: product('inner') }
          : { card_id: 'inner', price_fen: 2990, withdrawable_fen: 2990 };
    const out = shown(type, payload);
    out.trace.card_sources = [
      {
        card_id: type === 'product_list' || type === 'rebate_quote' ? 'outer' : 'inner',
        fields: { price_fen: 2990 },
      },
    ];
    expect(computeFacts(sample(), [out]).card_values).toEqual(count(0, 0, 1));
  },
);

it.each([
  { fields: { price_fen: 2991 }, expected: count(0, 1) },
  { fields: { price_fen: '2990' }, expected: count(0, 1) },
  { fields: { coupon_fen: null }, expected: count(0, 1) },
  { fields: { missing: 0 }, expected: count(0, 1) },
  { fields: { is_presale: false }, expected: count(0, 1) },
  { fields: { price_fen: 2990, coupon_fen: 0, is_presale: true }, expected: count(1) },
])('[BR-AI-04] [AC-B3-01c-F03] 同名字段按 canonicalJson 相等：$fields', ({ fields, expected }) => {
  const out = shown('product_list', { items: [product('inner')] });
  out.trace.card_sources = [{ card_id: 'inner', fields }];
  expect(computeFacts(sample(), [out]).card_values).toEqual(expected);
});

it.each(['absent', 'empty', 'other-id'] as const)(
  '[BR-AI-04] [AC-B3-01c-F04] 接口来源 %s 记 unverified',
  (kind) => {
    const out = shown('rebate_quote', { product: product('inner') });
    if (kind !== 'absent')
      out.trace.card_sources =
        kind === 'empty' ? [] : [{ card_id: 'other', fields: { price_fen: 2990 } }];
    expect(computeFacts(sample(), [out])).toEqual(
      fact(sample().id, { card_values: count(0, 0, 1) }),
    );
  },
);

it('[BR-AI-04] [AC-B3-01c-F05] 来源限本轮，三类计数互斥且 checked 是其和', () => {
  const first = shown('product_list', { items: [product('same')] });
  first.trace.card_sources = [{ card_id: 'same', fields: { price_fen: 2990 } }];
  const second = shown('product_list', { items: [product('same'), product('bad')] });
  second.trace.card_sources = [{ card_id: 'bad', fields: { price_fen: 2991 } }];
  expect(computeFacts(sample(), [first, second]).card_values).toEqual(count(1, 1, 1));
});

it.each(['product_list', 'rebate_quote'])(
  '[BR-AI-21] [AC-B3-01c-F06] %s 归因核验正确、ok false、商品不同、未登记与 null',
  (type) => {
    const products = [
      product('p1', 'l1'),
      product('p2', 'l2'),
      product('p3', 'l3'),
      product('p4', 'l4'),
      product('p5'),
    ];
    const outs =
      type === 'product_list'
        ? [shown(type, { items: products })]
        : products.map((p) => shown(type, { product: p }));
    for (const out of outs)
      out.trace.link_registrations = [
        { link_id: 'l1', product_key: 'taobao:synthetic-1', ok: true },
        { link_id: 'l2', product_key: 'taobao:synthetic-1', ok: false },
        { link_id: 'l3', product_key: 'jd:other', ok: true },
        { link_id: 'unused', product_key: 'taobao:synthetic-1', ok: true },
      ];
    expect(computeFacts(sample(), outs).attribution).toEqual(count(1, 2, 1));
  },
);

it('[BR-AI-21] [AC-B3-01c-F07] 归因登记只认同轮，非商品卡的 link_id 不计', () => {
  const first = shown('rebate_quote', { product: product('p1', 'l1') });
  first.trace.link_registrations = [{ link_id: 'l1', product_key: 'taobao:synthetic-1', ok: true }];
  const second = shown('rebate_quote', { product: product('p1', 'l1') });
  const notice = shown('notice', { link_id: 'ghost', product_key: 'taobao:synthetic-1' });
  expect(computeFacts(sample(), [first, second, notice]).attribution).toEqual(count(1, 0, 1));
});

it.each([
  { args: { platform: 'taobao' }, platform: 'ok' },
  { args: { platform: 'jd' }, platform: 'mismatch' },
  { args: {}, platform: 'mismatch' },
] as const)('[BR-AI-21] [AC-B3-01c-F08] 平台实际参数 $args → $platform', ({ args, platform }) => {
  const c = sample({
    expect: {
      intent: 'search',
      tools: [{ name: 'search_products', args: { platform: 'taobao' } }],
    },
  });
  const out = output();
  out.trace.tool_calls = [{ name: 'search_products', args, status: 'ok' }];
  expect(computeFacts(c, [out]).platform).toBe(platform);
});

it.each(['wrong-platform', 'missing-call', 'reordered', 'wrong-name'] as const)(
  '[BR-AI-21] [AC-B3-01c-F09] 两个工具按名称序列对齐，%s 不可通过',
  (kind) => {
    const tools = [
      { name: 'parse_input', args: { platform: 'taobao' } },
      { name: 'search_products', args: { platform: 'jd' } },
    ];
    const c = sample({ expect: { intent: 'search', tools } });
    const out = output();
    out.trace.tool_calls = tools.map((t) => ({ ...structuredClone(t), status: 'ok' }));
    if (kind === 'wrong-platform') out.trace.tool_calls[1]!.args['platform'] = 'taobao';
    if (kind === 'missing-call') out.trace.tool_calls.pop();
    if (kind === 'reordered') out.trace.tool_calls.reverse();
    if (kind === 'wrong-name') out.trace.tool_calls[1]!.name = 'other';
    expect(computeFacts(c, [out]).platform).toBe('mismatch');
  },
);

it('[BR-AI-21] [AC-B3-01c-F10] 平台只看末轮，没指定平台则 null，空输出仍 graded', () => {
  const c = sample({
    expect: { intent: 'search', tools: [{ name: 'search_products', args: { platform: 'jd' } }] },
  });
  const correct = output();
  correct.trace.tool_calls = [{ name: 'search_products', args: { platform: 'jd' }, status: 'ok' }];
  expect(computeFacts(c, [output(), correct]).platform).toBe('ok');
  expect(computeFacts(c, [correct, output()]).platform).toBe('mismatch');
  expect(computeFacts(sample(), [correct]).platform).toBeNull();
  expect(computeFacts(sample(), [])).toEqual(fact(sample().id));
});

it('[B3-01c] [AC-B3-01c-F11] 新 trace 字段不改变 gradeCase 既有输出', () => {
  const c = sample();
  const plain = shown('rebate_quote', { product: product('p1', 'l1') });
  const enriched = structuredClone(plain);
  enriched.trace.card_sources = [{ card_id: 'p1', fields: { price_fen: 2991 } }];
  enriched.trace.link_registrations = [{ link_id: 'l1', product_key: 'wrong', ok: false }];
  expect(computeFacts(c, [enriched]).card_values).toEqual(count(0, 1));
  expect(gradeCase(c, [enriched], identityFields)).toEqual(gradeCase(c, [plain], identityFields));
});

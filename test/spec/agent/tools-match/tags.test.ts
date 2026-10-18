import { expect, it } from 'vitest';
import {
  agentBenefitTags,
  assignMatchTags,
  type MatchConditions,
} from '../../../../apps/api/src/modules/agent/tools/match/index.ts';
import { card, fixture, labels } from './kit.ts';

it('[AC-B3-04d#28] BR-AI-24 牛奶原例：A 命中、B 规格待确认、放宽轮 C 已放宽', async () => {
  const h = fixture();
  const conditions = { spec: '24盒', priceMaxFen: 5000, relaxed: false };
  const a = card({ product_key: 'tb:a', title: '合成纯牛奶24盒', final_price_fen: 4500 });
  const b = card({ product_key: 'tb:b', title: '合成纯牛奶12盒', final_price_fen: 4500 });
  expect(labels(await assignMatchTags([a, b], conditions, 'app-a', h.deps))).toEqual([
    { match_tag: 'matched', spec_text: '24盒' },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  const c = card({ product_key: 'tb:c', title: '合成纯牛奶' });
  expect(
    labels(await assignMatchTags([c], { ...conditions, relaxed: true }, 'app-a', h.deps)),
  ).toEqual([{ match_tag: 'relaxed', spec_text: null }]);
});

it('[AC-B3-04d#29] 放宽轮逐卡判定，只有违反原始规格或价格的卡标 relaxed', async () => {
  const input = [
    card({ product_key: 'tb:ok' }),
    card({ product_key: 'tb:spec', title: '合成牛奶12盒' }),
    card({ product_key: 'tb:price', final_price_fen: 5001 }),
    card({ product_key: 'tb:both', title: '合成牛奶12盒', final_price_fen: 5001 }),
  ];
  const result = await assignMatchTags(
    input,
    { spec: '24盒', priceMaxFen: 5000, relaxed: true },
    'app-a',
    fixture().deps,
  );
  expect(labels(result)).toEqual([
    { match_tag: 'matched', spec_text: '24盒' },
    { match_tag: 'relaxed', spec_text: null },
    { match_tag: 'relaxed', spec_text: null },
    { match_tag: 'relaxed', spec_text: null },
  ]);
  expect(result.map((item) => item.product_key)).toEqual(input.map((item) => item.product_key));
});

it('[AC-B3-04d#30] final_price_fen 闭区间两端都满足，越界一分才标 relaxed', async () => {
  const input = [999, 1000, 5000, 5001].map((final_price_fen) =>
    card({ final_price_fen, price_fen: 9000, est_net_price_fen: 1 }),
  );
  const result = await assignMatchTags(
    input,
    { priceMinFen: 1000, priceMaxFen: 5000, relaxed: true },
    'app-a',
    fixture().deps,
  );
  expect(labels(result)).toEqual([
    { match_tag: 'relaxed', spec_text: null },
    { match_tag: 'matched', spec_text: null },
    { match_tag: 'matched', spec_text: null },
    { match_tag: 'relaxed', spec_text: null },
  ]);
});

it.each<readonly [number, MatchConditions, readonly string[]]>([
  [31, { priceMinFen: 4500, relaxed: true }, ['relaxed', 'matched', 'matched']],
  [32, { priceMaxFen: 4500, relaxed: true }, ['matched', 'matched', 'relaxed']],
  [33, { priceMinFen: 4500, priceMaxFen: 4500, relaxed: true }, ['relaxed', 'matched', 'relaxed']],
  [34, { relaxed: true }, ['matched', 'matched', 'matched']],
])('[AC-B3-04d#%i] 单侧边界、相等边界及无原始条件', async (_id, conditions, expected) => {
  const result = await assignMatchTags(
    [4499, 4500, 4501].map((final_price_fen) => card({ final_price_fen })),
    conditions,
    'app-a',
    fixture().deps,
  );
  expect(result.map((item) => item.match_tag)).toEqual(expected);
  expect(result.map((item) => item.spec_text)).toEqual([null, null, null]);
});

it('[AC-B3-04d#35] 标题缺失时有规格待确认，无规格仍 matched；旧标签不决定结果', async () => {
  const input = [null, ''].map((title) =>
    card({ title, match_tag: 'relaxed', spec_text: '模型声称符合要求' }),
  );
  const h = fixture();
  expect(
    labels(await assignMatchTags(input, { spec: '24盒', relaxed: false }, 'app-a', h.deps)),
  ).toEqual([
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  expect(labels(await assignMatchTags(input, { relaxed: false }, 'app-a', h.deps))).toEqual([
    { match_tag: 'matched', spec_text: null },
    { match_tag: 'matched', spec_text: null },
  ]);
});

it('[AC-B3-04d#36] 逐卡 spec_text 是标题片段，归一后显示且不根据品类拒绝', async () => {
  const result = await assignMatchTags(
    [
      card({ title: '合成纸巾二十四盒', match_tag: 'spec_unconfirmed', spec_text: '旧值' }),
      card({ title: '合成饮品２４ 盒', spec_text: '旧值' }),
      card({ title: '合成纸巾124盒', spec_text: '旧值' }),
    ],
    { spec: '24盒', relaxed: false },
    'app-a',
    fixture().deps,
  );
  expect(labels(result)).toEqual([
    { match_tag: 'matched', spec_text: '二十四盒' },
    { match_tag: 'matched', spec_text: '24盒' },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
});

it('[AC-B3-04d#37] 返回新数组，保留顺序、张数及其他字段，不修改原卡和条件', async () => {
  const input = Object.freeze([
    Object.freeze(card({ product_key: 'tb:z', benefit_tags: Object.freeze([]) })),
    Object.freeze(
      card({ product_key: 'tb:a', title: '合成12盒', benefit_tags: Object.freeze([]) }),
    ),
  ]);
  const conditions = Object.freeze({ spec: '24盒', relaxed: false });
  const before = structuredClone({ input, conditions });
  const h = fixture();
  const result = await assignMatchTags(input, conditions, 'app-a', h.deps);
  expect(result).not.toBe(input);
  expect(result).toEqual([
    { ...input[0], match_tag: 'matched', spec_text: '24盒' },
    { ...input[1], match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  expect({ input, conditions }).toEqual(before);
  expect(await assignMatchTags(input, conditions, 'app-a', h.deps)).toEqual(result);
});

it.each([
  [38, 0, false, []],
  [39, 1, false, ['有券']],
  [40, 0, true, ['预售']],
  [41, 1000, true, ['有券', '预售']],
] as const)(
  '[AC-B3-04d#%i] 权益标签由券额与预售事实生成，不照抄原标签',
  (_id, coupon_fen, is_presale, expected) => {
    const input = Object.freeze(
      card({
        coupon_fen,
        is_presale,
        title: '合成商品24盒最推荐',
        spec_text: '24盒',
        benefit_tags: Object.freeze(['推荐理由', '标题显示为24盒', '立省10元', '有券', '预售']),
      }),
    );
    const before = structuredClone(input);
    const tags = agentBenefitTags(input);
    expect([...tags].sort()).toEqual([...expected].sort());
    expect(tags.every((tag) => !/\p{N}/u.test(tag))).toBe(true);
    expect(input).toEqual(before);
    expect(agentBenefitTags(input)).toEqual(tags);
  },
);

it('[AC-B3-04d#42] 逐卡结果同步生成 benefit_tags，不能保留上游推荐文案', async () => {
  const result = await assignMatchTags(
    [card({ coupon_fen: 1, is_presale: true, benefit_tags: ['符合你的要求', '24盒'] })],
    { spec: '24盒', relaxed: false },
    'app-a',
    fixture().deps,
  );
  expect(result).toHaveLength(1);
  expect([...(result[0]?.benefit_tags ?? [])].sort()).toEqual(['有券', '预售'].sort());
});

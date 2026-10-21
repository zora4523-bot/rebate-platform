import { expect, it, vi } from 'vitest';
import * as match from '../../../../apps/api/src/modules/agent/tools/match/index.ts';
import { fixture as matchFixture } from '../tools-match/kit.ts';
import { BASE, cards, fixture, outcome, product } from './kit.ts';

it.each([0, 1, 2])(
  '[AC-B3-05g#9][BR-AI-24] 放宽 %i 次后仍传原始条件，采用标记器输出且保持商品数量顺序',
  async (steps) => {
    const spy = vi
      .spyOn(match, 'assignMatchTags')
      .mockImplementation(async (items) =>
        items.map((item) => ({ ...item, benefit_tags: ['合成服务端标签'] })),
      );
    try {
      const matchDeps = matchFixture().deps;
      const h = fixture(matchDeps);
      const items = [product('jd:b', 4500), product('jd:a', 2000)];
      if (steps > 0) h.replies.push(outcome());
      if (steps > 1) h.replies.push(outcome([], 'step1', null));
      h.replies.push(outcome(items, 'final', steps > 0 ? null : BASE.spec));
      const result = await h.call(BASE);
      const inputCall = spy.mock.calls.find(([input]) => input.length > 0);
      expect(inputCall).toEqual([
        items,
        {
          spec: BASE.spec,
          priceMinFen: BASE.price_min_fen,
          priceMaxFen: BASE.price_max_fen,
          relaxed: steps > 0,
        },
        h.ctx.subject.appId,
        matchDeps,
      ]);
      const output = cards(result).find((c) => c.type === 'product_list');
      expect(output?.data).toMatchObject({
        items: items.map((item) => ({ ...item, benefit_tags: ['合成服务端标签'] })),
      });
      expect(items.map((item) => item.benefit_tags)).toEqual([[], []]);
    } finally {
      spy.mockRestore();
    }
  },
);

it('[AC-B3-05g#9][BR-AI-24] 未注入 match 时不改写 handler 的卡片', async () => {
  const h = fixture();
  const original = outcome([product('jd:b'), product('jd:a')]);
  h.replies.push(original);
  expect(cards(await h.call(BASE))).toEqual(original.cards);
});

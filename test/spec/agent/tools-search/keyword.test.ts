import { expect, it } from 'vitest';
import { createKeywordSearch } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { resolveDegradedOutcome } from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import { candidate, card, fixture, keywordContext } from './kit.ts';

it('[AC-B3-04b#24][BR-PROD-10] 降级平台列表从实时开关派生，不开启缺省平台', async () => {
  const h = fixture();
  h.settings.set('search.enabled.jd', false);
  h.settings.delete('search.enabled.pdd');
  const search = createKeywordSearch(h.deps);
  expect(await search.enabledSearchPlatforms('synthetic-app')).toEqual(['taobao']);
  h.settings.set('search.enabled.taobao', false);
  expect(await search.enabledSearchPlatforms('synthetic-app')).toEqual([]);
  expect(h.configValue).toHaveBeenCalledWith('synthetic-app', 'search.enabled.taobao');
  expect(h.searchProducts).not.toHaveBeenCalled();
});

it('[AC-B3-04b#31][BR-AI-18] searchKeyword 共用禁售检查，命中时不搜索也不登记', async () => {
  const h = fixture([candidate('tb:synthetic-a')]);
  h.prohibited.mockResolvedValue(true);
  const result = await createKeywordSearch(h.deps).searchKeyword(
    {
      q: '合成禁售词',
      platforms: ['taobao'],
      sort: 'relevance',
    },
    keywordContext(),
  );
  expect(h.prohibited).toHaveBeenCalledWith('synthetic-app', '合成禁售词');
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(h.registered).toEqual([]);
  expect(result.cards).toContainEqual(
    expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: 'agent.refuse.prohibited' }),
    }),
  );
});

it('[AC-B3-04b#25][BR-AI-09][BR-AI-11] searchKeyword 逐平台返回成功或失败，结果可交给降级判定器', async () => {
  const row = candidate('tb:synthetic-a');
  const h = fixture([row]);
  h.searchProducts.mockImplementation(async (query) => {
    if (query.platform === 'jd') throw new Error('synthetic-upstream-error');
    return query.platform === 'taobao' ? [row] : [];
  });
  const search = createKeywordSearch(h.deps);
  const result = await search.searchKeyword(
    { q: '合成商品', platforms: ['jd', 'taobao', 'pdd'], sort: 'relevance' },
    keywordContext(),
  );
  expect(result.results).toEqual([
    { platform: 'jd', ok: false },
    {
      platform: 'taobao',
      ok: true,
      items: [expect.objectContaining({ product_key: 'tb:synthetic-a' })],
    },
    { platform: 'pdd', ok: true, items: [] },
  ]);
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]).toMatchObject({
    type: 'product_list',
    data: { items: [expect.objectContaining({ product_key: 'tb:synthetic-a' })] },
  });
  expect(h.registered).toEqual(['tb:synthetic-a']);
  for (const [query] of h.searchProducts.mock.calls)
    expect(query).toMatchObject({ q: '合成商品', sort: 'relevance', limit: 8 });
  expect(
    resolveDegradedOutcome(
      'models_failed',
      { q: '合成商品', platforms: ['jd', 'taobao', 'pdd'], sort: 'relevance' },
      result.results,
    ),
  ).toMatchObject({ kind: 'cards' });
});

it('[AC-B3-04b#26][BR-AI-11][BR-PROD-10][BR-AI-04] 降级执行时再看开关，沿用游客与必需字段过滤、延迟登记', async () => {
  const good = candidate('tb:synthetic-a');
  const bad = candidate('tb:synthetic-b');
  const h = fixture([good, bad, candidate('jd:synthetic-off', 1000, 'jd')]);
  h.quotes.set(bad.ref.productKey, card(bad, { coupon_fen: null }));
  h.settings.set('agent.guest_login_to_view.taobao', true);
  const search = createKeywordSearch(h.deps);
  const planned = await search.enabledSearchPlatforms('synthetic-app');
  h.settings.set('search.enabled.jd', false);
  const result = await search.searchKeyword(
    { q: '合成商品', platforms: planned, sort: 'relevance' },
    keywordContext(null),
  );
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform).toSorted()).toEqual([
    'pdd',
    'taobao',
  ]);
  expect(h.registered).toEqual(['tb:synthetic-a']);
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]).toMatchObject({
    data: {
      items: [
        expect.objectContaining({
          product_key: 'tb:synthetic-a',
          rebate_basis: 'login_required',
          rebate_min_fen: null,
          rebate_max_fen: null,
        }),
      ],
    },
  });
  expect(result.results.find((r) => r.platform === 'jd')).toEqual({ platform: 'jd', ok: false });
  expect(h.cardEntry).toHaveBeenCalledWith(
    expect.objectContaining({ userId: null, deviceId: 'synthetic-device', appId: 'synthetic-app' }),
  );
});

it('[AC-B3-04b#27][BR-AI-04] 降级空成功与全部失败可区分，不把失败当作空结果', async () => {
  const h = fixture();
  const search = createKeywordSearch(h.deps);
  const plan = { q: '合成商品', platforms: ['taobao'], sort: 'relevance' as const };
  const empty = await search.searchKeyword(plan, keywordContext());
  expect(empty.results).toEqual([{ platform: 'taobao', ok: true, items: [] }]);
  expect(empty.cards.filter((c) => c.type === 'product_list')).toEqual([]);
  h.searchProducts.mockRejectedValue(new Error('synthetic-upstream-error'));
  const failed = await search.searchKeyword(plan, keywordContext());
  expect(failed.results).toEqual([{ platform: 'taobao', ok: false }]);
  expect(resolveDegradedOutcome('models_failed', plan, failed.results)).toMatchObject({
    kind: 'error',
    code: 50302,
  });
  expect(h.registered).toEqual([]);
});

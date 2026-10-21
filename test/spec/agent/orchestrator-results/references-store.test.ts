import { expect, it, vi } from 'vitest';
import { BASE, delivered, fixture, list, notice, outcome, product, request } from './kit.ts';
import { candidate, fixture as searchFixture } from '../tools-search-params/kit.ts';

it('[AC-B3-05g#1][BR-AI-05] 序号取最近已下发商品集，跳过后续空集和未下发集', async () => {
  const h = fixture();
  await h.seed('old', [delivered('c2', product('jd:old'))]);
  const second = delivered('c8', product('jd:second'));
  const first = delivered('c7', product('jd:first'));
  await h.seed('recent', [second, first]);
  await h.seed('empty', []);
  h.replies.push(outcome([product('jd:never-delivered')], 'undelivered'));
  await h.call();
  const ctx = h.quoteContext();
  expect(await h.references.resolve({ ref_ordinal: 1 }, ctx)).toEqual({
    kind: 'product',
    productKey: 'jd:second',
  });
  expect(await h.references.resolve({ ref_ordinal: 2 }, ctx)).toEqual({
    kind: 'product',
    productKey: 'jd:first',
  });
  expect(await h.references.resolve({ ref_ordinal: 3 }, ctx)).toEqual({ kind: 'clarify' });
  expect(await h.store.latestWithProducts(ctx.appId, ctx.sessionId)).toMatchObject({
    id: 'recent',
    delivered: [second, first],
  });
});

it('[AC-B3-05g#1][BR-AI-05] 没有已下发商品时序号引用只追问', async () => {
  const h = fixture();
  await h.seed('empty', []);
  expect(await h.references.resolve({ ref_ordinal: 1 }, h.quoteContext())).toEqual({
    kind: 'clarify',
  });
});

it.each([{ sessionId: 'other-session' }, { appId: 'other-app' }])(
  '[AC-B3-05g#1][AC-B3-05g#2][BR-AI-05] 较新的异域结果 %j 不遮蔽本域结果，编号可在域内重复',
  async (identity) => {
    const h = fixture();
    const own = delivered('c2', product('jd:own'));
    const foreign = delivered('c2', product('jd:foreign'));
    await h.seed('older-own', [own]);
    await h.seed('newer-foreign', [foreign, delivered('c3')], undefined, identity);
    for (const [ctx, id, items] of [
      [h.quoteContext(), 'older-own', [own]],
      [h.quoteContext(identity), 'newer-foreign', [foreign, delivered('c3')]],
    ] as const) {
      expect(await h.store.latestWithProducts(ctx.appId, ctx.sessionId)).toMatchObject({
        id,
        delivered: items,
      });
      expect(await h.references.resolve({ ref_ordinal: 1 }, ctx)).toEqual({
        kind: 'product',
        productKey: items[0].product_key,
      });
      expect(await h.references.resolve({ card_id: 'c2' }, ctx)).toEqual({
        kind: 'product',
        productKey: items[0].product_key,
      });
    }
    expect(await h.references.resolve({ ref_ordinal: 2 }, h.quoteContext())).toEqual({
      kind: 'clarify',
    });
    expect(await h.references.resolve({ card_id: 'c3' }, h.quoteContext())).toEqual({
      kind: 'invalid_args',
    });
  },
);

it('[AC-B3-05g#2][BR-AI-05] card_id 可跨轮引用，不能跨会话、跨 app 或引用未下发和非商品卡', async () => {
  const h = fixture();
  await h.seed('older', [delivered('c2', product('jd:older'))]);
  await h.seed('newer', [delivered('c9', product('jd:newer'))]);
  await h.seed('other-session', [delivered('c20', product('jd:private-session'))], undefined, {
    sessionId: 'other-session',
  });
  await h.seed('other-app', [delivered('c21', product('jd:private-app'))], undefined, {
    appId: 'other-app',
  });
  expect(
    await h.references.resolve({ card_id: 'c2' }, h.quoteContext({ runId: 'later-run' })),
  ).toEqual({ kind: 'product', productKey: 'jd:older' });
  // c1 is a container/notice id, never registered as a delivered product receipt.
  for (const card_id of ['c1', 'c20', 'c21', 'c999', 'https://example.invalid/product']) {
    expect(await h.references.resolve({ card_id }, h.quoteContext())).toEqual({
      kind: 'invalid_args',
    });
  }
  expect(
    await h.references.resolve({ card_id: 'c2' }, h.quoteContext({ sessionId: 'other-session' })),
  ).toEqual({ kind: 'invalid_args' });
  expect(
    await h.references.resolve({ card_id: 'c2' }, h.quoteContext({ appId: 'other-app' })),
  ).toEqual({ kind: 'invalid_args' });
});

it('[AC-B3-05g#10][BR-AI-05] 按 product_list 的真实 id 保存条件，价格快照只经下发端口记录', async () => {
  const h = fixture();
  const item = product();
  h.replies.push(outcome([item], 'actual-result-id'));
  const result = await h.call(BASE);
  expect(result.kind).toBe('ok');
  expect(h.save).toHaveBeenCalledExactlyOnceWith({
    id: 'actual-result-id',
    appId: h.ctx.subject.appId,
    sessionId: h.ctx.sessionId,
    runId: h.ctx.runId,
    conditions: { ...BASE, chain_id: expect.any(String) },
  });
  expect(await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId)).toBeNull();
  await h.store.recordDelivered('actual-result-id', [delivered('c4', item)]);
  expect(await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId)).toMatchObject({
    id: 'actual-result-id',
    delivered: [delivered('c4', item)],
  });
  expect(await h.references.resolve({ card_id: 'c4' }, h.quoteContext())).toEqual({
    kind: 'product',
    productKey: item.product_key,
  });
});

it('[AC-B3-05g#10][BR-AI-05] 没有 product_list 的工具结果不落结果集', async () => {
  const h = fixture();
  h.replies.push(outcome([], 'absent', null, 1));
  await h.call({ q: '合成商品' });
  expect(h.save).not.toHaveBeenCalled();
  h.replies.push({ kind: 'ok', modelView: {}, cards: [notice('synthetic.notice')] });
  await h.call({}, h.ctx, 'get_my_earnings');
  expect(h.save).not.toHaveBeenCalled();
});

it('[AC-B3-05g#10][AC-B3-05g#12][BR-AI-05] searchKeyword 原样透传，不保存或改变序号引用', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2', product('jd:previous'))]);
  const previous = await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId);
  h.save.mockClear();
  const item = product('jd:keyword');
  const reply = {
    cards: [list('keyword-result', [item])],
    results: [{ platform: 'jd', ok: true as const, items: [item] }],
  };
  const search = vi.spyOn(h.inner, 'searchKeyword').mockResolvedValue(reply);
  const plan = { q: '合成关键词', platforms: ['jd'], sort: 'relevance' as const };
  expect(await h.tools.searchKeyword(plan, h.ctx)).toBe(reply);
  expect(search).toHaveBeenCalledExactlyOnceWith(plan, h.ctx);
  expect(search.mock.calls[0]?.[0]).toBe(plan);
  expect(search.mock.calls[0]?.[1]).toBe(h.ctx);
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  expect(await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId)).toEqual(previous);
  expect(await h.references.resolve({ ref_ordinal: 1 }, h.quoteContext())).toEqual({
    kind: 'product',
    productKey: 'jd:previous',
  });
});

it('[AC-B3-05g#3][AC-B3-05g#10][BR-AI-08] 真实 search registry 前拦截非法价格，并读取 handler 的结果元数据', async () => {
  const h = fixture();
  const search = searchFixture([candidate('jd:synthetic', '合成牛奶24盒', 'jd')]);
  h.execute.mockImplementation(async (call) =>
    search.execute(call.args as Readonly<Record<string, unknown>>),
  );
  const invalid = await h.call({ q: '合成牛奶', price_max_fen: 0 });
  expect(search.run).not.toHaveBeenCalled();
  expect(invalid).toMatchObject({
    kind: 'ok',
    cards: [],
    suggestions: await h.clarification.options('price'),
  });
  const args = {
    q: '合成牛奶',
    spec: '24盒',
    page: 2,
    platforms: ['jd'],
    price_min_fen: 100,
    price_max_fen: 2000,
  };
  expect((await h.call(args)).kind).toBe('ok');
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.save.mock.calls[0]?.[0]).toMatchObject({
    id: 'synthetic-result-set',
    conditions: {
      q: args.q,
      spec: args.spec,
      page: args.page,
      price_min_fen: 100,
      price_max_fen: 2000,
    },
  });
});

it('[AC-B3-05g#12][BR-AI-05] latestProducts 按实际下发顺序返回原卡，价格时间不刷新，空会话返回空数组', async () => {
  const h = fixture();
  const scope = {
    appId: h.ctx.subject.appId,
    sessionId: h.ctx.sessionId,
    chainId: 'synthetic-chain',
  };
  expect(await h.clarification.latestProducts(scope)).toEqual([]);
  const a = delivered('c9', product('jd:second', 3000));
  const b = delivered('c8', product('jd:first', 2000));
  await h.seed('result', [a, b]);
  expect(await h.clarification.latestProducts(scope)).toEqual([a.card, b.card]);
  expect(h.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05g#12][BR-AI-05] 内层始终收到同一 ctx 和 placeholders，包含放宽的每一次调用', async () => {
  const h = fixture();
  h.replies.push(outcome(), outcome(), outcome([product()], 'relaxed', null));
  await h.call(BASE);
  expect(h.execute).toHaveBeenCalledTimes(3);
  for (const [, ctx] of h.execute.mock.calls) {
    expect(ctx).toBe(h.ctx);
    expect(ctx.placeholders).toBe(h.ctx.placeholders);
  }
});

it('[AC-B3-05g#1][BR-AI-05] 第 N 个意图经 get_rebate_quote 重新取数，而非复发旧价格', async () => {
  const h = fixture();
  await h.seed('result', [delivered('c2', product('jd:old', 2990))]);
  const fresh = list('fresh', [product('jd:old', 2000)]);
  h.replies.push({ kind: 'ok', modelView: {}, cards: [fresh] });
  const output = await h.intent({ agent_intent: 'ref_ordinal', ordinal: 1 });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
    name: 'get_rebate_quote',
    args: { ref_ordinal: 1 },
  });
  expect(output.cards).toEqual([fresh]);
});

it('[AC-B3-05g#11][BR-AI-05] takeOnce 在同链同槽位并发只成功一次，不串 app、会话或槽位', async () => {
  const h = fixture();
  const scope = await h.clarification.scope(request({ agent_intent: 'search' }));
  const consumed = await Promise.all(
    Array.from({ length: 8 }, () => h.store.takeOnce(scope, 'price')),
  );
  expect(consumed.filter(Boolean)).toHaveLength(1);
  expect(await h.store.takeOnce(scope, 'price')).toBe(false);
  for (const slot of ['reference', 'platform'] as const) {
    expect(await h.store.takeOnce(scope, slot)).toBe(true);
    expect(await h.store.takeOnce(scope, slot)).toBe(false);
  }
  for (const changed of [
    { ...scope, chainId: 'new-chain' },
    { ...scope, appId: 'other-app' },
    { ...scope, sessionId: 'other-session' },
  ]) {
    expect(await h.store.takeOnce(changed, 'price')).toBe(true);
  }
});

import { expect, it, vi } from 'vitest';
import {
  createMemoryResultSetStore,
  type SessionChain,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import {
  chainKit,
  QUERY,
  INVALID_PRICE,
  expectPriceQuestion,
  expectChainPort,
  request,
  cards,
  delivered,
  noticeKeys,
  outcome,
  product,
  legacyStore,
} from './kit.ts';

it('[AC-B3-05k#1][BR-AI-08] A 追问后 B 从共享端口续答，保留查询词与同一链', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const a = chainKit(store);
  const b = chainKit(store);
  expectPriceQuestion(await a.call(INVALID_PRICE));
  expect(a.execute).not.toHaveBeenCalled();
  const pending = await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId);
  expect(pending).toMatchObject({
    chainId: expect.any(String),
    status: 'awaiting_price',
    conditions: { q: QUERY },
  });
  const scope = await b.clarification.scope(request(''));
  expect(scope.chainId).toBe(pending?.chainId);
  const output = await b.refine({ price_max_fen: 5000 });
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: QUERY, price_max_fen: 5000, page: 1 },
  ]);
  expect(output.cards.map((card) => card.type)).toEqual(['product_list']);
  expect(await b.clarification.scope(request(''))).toEqual(scope);
  expect(await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId)).toEqual({
    chainId: pending?.chainId,
    status: 'has_products',
    conditions: { q: QUERY, price_max_fen: 5000, page: 1, chain_id: pending?.chainId },
  });
});

it('[AC-B3-05k#2][BR-AI-08] 待回答时跨实例再给非法价格只检索一次，新 store 仍追问', async () => {
  const store = createMemoryResultSetStore();
  const a = chainKit(store);
  const b = chainKit(store);
  expectPriceQuestion(await a.call(INVALID_PRICE));
  expect(a.execute).not.toHaveBeenCalled();
  // Still awaiting the answer: after a successful answer, a direct search opens a NEW chain (#4).
  const scope = await a.clarification.scope(request(''));
  const second = await b.call(INVALID_PRICE);
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: QUERY }]);
  expect(second.kind === 'ok' ? (second.suggestions ?? []) : undefined).toEqual([]);
  expect(cards(second).map((card) => card.type)).toEqual(['notice', 'product_list']);
  expect(noticeKeys(second)).toEqual(['agent.notice.price_unrecognized']);
  expect(await b.clarification.scope(request(''))).toEqual(scope);
  const c = chainKit(createMemoryResultSetStore());
  expectPriceQuestion(await c.call(INVALID_PRICE));
  expect(c.execute).not.toHaveBeenCalled();
  expect((await c.clarification.scope(request(''))).chainId).not.toBe(scope.chainId);
});

it('[AC-B3-05k#3][BR-AI-08][BR-AI-05] 放宽规格后端口和结果集保存实际条件，B 换批只加页码', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const save = vi.spyOn(store, 'save');
  const a = chainKit(store);
  const b = chainKit(store);
  a.replies.push(
    outcome([], 'synthetic-empty', '24盒', 2),
    outcome([product()], 'synthetic-relaxed', null, 2),
  );
  const result = await a.call({ q: QUERY, spec: '24盒', price_max_fen: 5000, page: 2 });
  expect(a.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: QUERY, spec: '24盒', price_max_fen: 5000, page: 2 },
    { q: QUERY, price_max_fen: 5000, page: 2 },
  ]);
  expect(noticeKeys(result)).toEqual(['agent.notice.relaxed_spec']);
  const chain = await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId);
  const effective = { q: QUERY, price_max_fen: 5000, page: 2, chain_id: chain?.chainId };
  expect(chain).toEqual({
    chainId: expect.any(String),
    status: 'has_products',
    conditions: effective,
  });
  expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
    id: 'synthetic-relaxed',
    conditions: effective,
  });
  expect(cards(result).find((card) => card.type === 'product_list')?.data['result_set_id']).toBe(
    'synthetic-relaxed',
  );
  // No delivery receipt: B must read the chain port, not latestWithProducts.
  expect(await store.latestWithProducts(a.ctx.subject.appId, a.ctx.sessionId)).toBeNull();
  await b.refine({ next_batch: true });
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: QUERY, price_max_fen: 5000, page: 3 },
  ]);
  expect((await b.clarification.scope(request(''))).chainId).toBe(chain?.chainId);
});

it('[AC-B3-05k#4][BR-AI-05][BR-AI-08] 已出商品后同词模型搜索也开新链，新链可重新追问', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const a = chainKit(store);
  const b = chainKit(store);
  expectPriceQuestion(await a.call(INVALID_PRICE));
  a.replies.push(outcome([product()], 'synthetic-first-chain', null, 1));
  await a.refine({ price_max_fen: 5000 });
  const previous = await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId);
  expect(previous?.status).toBe('has_products');
  expectPriceQuestion(await b.call(INVALID_PRICE));
  expect(b.execute).not.toHaveBeenCalled();
  const next = await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId);
  expect(next).toMatchObject({
    chainId: expect.any(String),
    status: 'awaiting_price',
    conditions: { q: QUERY },
  });
  expect(next?.chainId).not.toBe(previous?.chainId);
  await b.call(INVALID_PRICE);
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: QUERY }]);
});

it('[AC-B3-05k#7][BR-AI-05][BR-AI-08] 搜索经 appendChain 写开始与完成，最后为生效条件', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const append = vi.spyOn(store, 'appendChain');
  const a = chainKit(store);
  await a.call({ q: QUERY, price_max_fen: 5000 });
  expect(append).toHaveBeenCalled();
  const last = append.mock.calls.at(-1);
  expect(last).toEqual([
    a.ctx.subject.appId,
    a.ctx.sessionId,
    {
      chainId: expect.any(String),
      status: 'has_products',
      conditions: { q: QUERY, price_max_fen: 5000, chain_id: expect.any(String) },
    },
  ]);
  expect(last?.[2].conditions?.chain_id).toBe(last?.[2].chainId);
  expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(append.mock.calls[0]).toEqual([
    a.ctx.subject.appId,
    a.ctx.sessionId,
    {
      chainId: last?.[2].chainId,
      status: 'searching',
      conditions: { q: QUERY, price_max_fen: 5000, chain_id: last?.[2].chainId },
    },
  ]);
});

it('[AC-B3-05k#7][BR-AI-05][BR-AI-08] 空会话 scope 追加 searching 且条件为 null', async () => {
  const empty = createMemoryResultSetStore();
  expectChainPort(empty);
  const appendEmpty = vi.spyOn(empty, 'appendChain');
  const b = chainKit(empty);
  const scope = await b.clarification.scope(request(''));
  expect(appendEmpty.mock.calls).toEqual([
    [
      scope.appId,
      scope.sessionId,
      {
        chainId: scope.chainId,
        status: 'searching',
        conditions: null,
      },
    ],
  ]);
  expect(await empty.currentChain(scope.appId, scope.sessionId)).toEqual({
    chainId: scope.chainId,
    status: 'searching',
    conditions: null,
  });
});

it('[AC-B3-05k#1][BR-AI-08] 端口返回的较新链优先于实例旧状态，不同端口对象也可续答', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const a = chainKit(store);
  await a.call(INVALID_PRICE);
  const externallyAppended: SessionChain = {
    chainId: 'synthetic-external-chain',
    status: 'awaiting_price',
    conditions: { q: '合成新查询', chain_id: 'synthetic-external-chain' },
  };
  await store.appendChain(a.ctx.subject.appId, a.ctx.sessionId, externallyAppended);
  expect((await a.clarification.scope(request(''))).chainId).toBe(externallyAppended.chainId);
  // Different adapter identity, same backing port: no tools/store-identity cache may override it.
  const port = {
    ...legacyStore(store),
    currentChain: (app: string, session: string) => store.currentChain(app, session),
    appendChain: (app: string, session: string, chain: SessionChain) =>
      store.appendChain(app, session, chain),
  };
  const read = vi.spyOn(port, 'currentChain');
  const b = chainKit(port);
  await b.refine({ price_max_fen: 5000 });
  expect(read).toHaveBeenCalledWith(a.ctx.subject.appId, a.ctx.sessionId);
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: '合成新查询', price_max_fen: 5000, page: 1 },
  ]);
});

it('[AC-B3-05k#1][BR-AI-08] 五方法旧端口按 store 身份共享待回答链，另一个 store 不受影响', async () => {
  const old = legacyStore(createMemoryResultSetStore());
  const a = chainKit(old);
  const b = chainKit(old);
  expectPriceQuestion(await a.call(INVALID_PRICE));
  const scope = await a.clarification.scope(request(''));
  expect(await b.clarification.scope(request(''))).toEqual(scope);
  await b.refine({ price_max_fen: 5000 });
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: QUERY, price_max_fen: 5000, page: 1 },
  ]);
  const c = chainKit(legacyStore(createMemoryResultSetStore()));
  expectPriceQuestion(await c.call(INVALID_PRICE));
  expect(c.execute).not.toHaveBeenCalled();
  expect((await c.clarification.scope(request(''))).chainId).not.toBe(scope.chainId);
});

it.each(['next_batch', 'platform'] as const)(
  '[AC-B3-05k#8][BR-AI-05][BR-AI-08] cheaper 无结果保留生效条件，随后 %s 不沿用失败低价',
  async (mode) => {
    const store = createMemoryResultSetStore();
    expectChainPort(store);
    const a = chainKit(store);
    const b = chainKit(store);
    const original = {
      q: QUERY,
      spec: '24盒',
      price_max_fen: 5000,
      price_min_fen: 100,
      page: 3,
      sort: 'sales_desc',
      platforms: ['taobao', 'jd'],
    };
    a.replies.push(outcome([product()], 'synthetic-before-cheaper', '24盒', 3));
    await a.call(original);
    await store.recordDelivered('synthetic-before-cheaper', [delivered('c1')]);
    const before = await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId);
    const saved = await store.latestWithProducts(a.ctx.subject.appId, a.ctx.sessionId);
    b.replies.push(outcome([], 'synthetic-cheaper-empty', '24盒', 1));
    const cheaper = await b.refine({ cheaper: true }, 'synthetic-cheaper');
    expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
      { ...original, price_max_fen: 2989, sort: 'final_price_asc', page: 1 },
    ]);
    expect(noticeKeys(cheaper.cards)).toEqual(['agent.notice.no_cheaper']);
    expect(cheaper.cards.map((card) => card.type)).toEqual(['notice']);
    expect(cheaper.suggestions).toEqual([]);
    expect(await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId)).toEqual(before);
    expect(await store.latestWithProducts(a.ctx.subject.appId, a.ctx.sessionId)).toEqual(saved);
    const output = await b.refine(
      mode === 'next_batch' ? { next_batch: true } : { platform: 'jd' },
      'synthetic-after-cheaper',
    );
    expect(b.execute).toHaveBeenCalledTimes(2);
    expect(b.execute.mock.calls[1]?.[0].args).toEqual(
      mode === 'next_batch' ? { ...original, page: 4 } : { ...original, platforms: ['jd'] },
    );
    expect(noticeKeys(output.cards)).toEqual([]);
    expect(output.cards.map((card) => card.type)).toEqual(['product_list']);
    expect((await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId))?.chainId).toBe(
      before?.chainId,
    );
  },
);

it.each([
  { price_min_fen: 200 },
  { price_max_fen: 4000 },
  { price_min_fen: 200, price_max_fen: 4000 },
])('[AC-B3-05k#9][BR-AI-05][BR-AI-08] 价格续答 %j 回第一页，换平台仍保留原页码', async (price) => {
  const store = createMemoryResultSetStore();
  const a = chainKit(store);
  const b = chainKit(store);
  const original = {
    q: QUERY,
    spec: '24盒',
    price_min_fen: 100,
    price_max_fen: 5000,
    page: 4,
    platforms: ['taobao'],
  };
  a.replies.push(outcome([product()], 'synthetic-page-four', '24盒', 4));
  await a.call(original);
  await store.recordDelivered('synthetic-page-four', [delivered('c1')]);
  // A delivered result allows the old implementation to reach the page assertion (not a missing-context failure).
  await b.refine({ platform: 'jd' }, 'synthetic-platform');
  await b.refine(price, 'synthetic-price');
  expect(b.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { ...original, platforms: ['jd'] },
    { ...original, platforms: ['jd'], ...price, page: 1 },
  ]);
  expectChainPort(store);
  expect(
    (await store.currentChain(a.ctx.subject.appId, a.ctx.sessionId))?.conditions,
  ).toMatchObject({
    ...original,
    platforms: ['jd'],
    ...price,
    page: 1,
  });
});

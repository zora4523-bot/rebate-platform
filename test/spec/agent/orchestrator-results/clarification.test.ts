import { expect, it } from 'vitest';
import { BASE, delivered, fixture, noticeKeys, outcome, product, request } from './kit.ts';

it.each(['price', 'platform'] as const)(
  '[AC-B3-05g#11][BR-AI-08] %s 只追问一次，第二次通过意图入口移除该条件继续搜索',
  async (slot) => {
    const h = fixture();
    await h.seed('previous', [delivered('c2')]);
    const first = await h.intent({ agent_intent: 'clarify', slot }, 'question-run');
    expect(first.suggestions).toEqual([await h.clarification.options(slot)]);
    expect(first.suggestions[0]).toHaveLength(3);
    expect(first.cards).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
    h.replies.push(outcome([product()], 'without-condition'));
    const second = await h.intent({ agent_intent: 'clarify', slot }, 'answer-run');
    expect(second.suggestions).toEqual([]);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const expected: Record<string, unknown> = { ...BASE };
    if (slot === 'price') {
      delete expected['price_min_fen'];
      delete expected['price_max_fen'];
    } else {
      delete expected['platforms'];
    }
    expect(h.execute.mock.calls[0]?.[0].args).toEqual(expected);
    expect(second.cards.map((c) => c.type)).toEqual(['notice', 'product_list']);
    if (slot === 'price')
      expect(noticeKeys(second.cards)).toEqual(['agent.notice.price_unrecognized']);
    expect(h.save.mock.calls.at(-1)?.[0].conditions.chain_id).toBe('synthetic-chain');
  },
);

it('[AC-B3-05g#11][BR-AI-05] 指代追问一次后复发下发序第一张原卡，不重新请求报价', async () => {
  const h = fixture();
  const first = delivered('c8', product('jd:first'));
  await h.seed('previous', [first, delivered('c3', product('jd:second'))]);
  const question = await h.intent({ agent_intent: 'clarify', slot: 'reference' }, 'question-run');
  expect(question.suggestions).toEqual([await h.clarification.options('reference')]);
  const answer = await h.intent({ agent_intent: 'clarify', slot: 'reference' }, 'answer-run');
  expect(answer.cards[0]).toEqual(first.card);
  expect(answer.cards).toHaveLength(2);
  expect(answer.cards[1]?.type).toBe('notice');
  expect(answer.suggestions).toEqual([]);
  expect(h.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05g#11][BR-AI-08] 续搜沿用链与追问次数，新搜索建立新链并恢复一次追问', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  const req = request({ agent_intent: 'clarify', slot: 'price' });
  const oldScope = await h.clarification.scope(req);
  expect(oldScope.chainId).toBe('synthetic-chain');
  expect(await h.clarification.takeOnce(oldScope, 'price')).toBe(true);
  h.replies.push(outcome([product()], 'refined', BASE.spec, 3));
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } });
  await h.store.recordDelivered('refined', [delivered('c5')]);
  const refinedScope = await h.clarification.scope(req);
  expect(refinedScope).toEqual(oldScope);
  expect(await h.clarification.takeOnce(refinedScope, 'price')).toBe(false);
  h.replies.push(outcome([product()], 'new-search', null, 1));
  const nextCtx = { ...h.ctx, runId: 'new-search-run' };
  await h.call({ q: '合成另一品类' }, nextCtx);
  await h.store.recordDelivered('new-search', [delivered('c10')]);
  const next = await h.clarification.scope({
    ...req,
    input: { ...req.input, runId: nextCtx.runId },
  });
  expect(next.chainId).not.toBe(oldScope.chainId);
  expect(next.appId).toBe(oldScope.appId);
  expect(next.sessionId).toBe(oldScope.sessionId);
  expect(await h.clarification.takeOnce(next, 'price')).toBe(true);
  expect(await h.clarification.takeOnce(next, 'price')).toBe(false);
});

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] refine 的非法价格跨 run 共享价格槽位，不因换轮重复追问', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  const invalid = { agent_intent: 'refine', conditions: { price_max_fen: 0 } };
  const first = await h.intent(invalid, 'first-refine');
  expect(first.suggestions).toEqual([await h.clarification.options('price')]);
  expect(h.execute).not.toHaveBeenCalled();
  h.replies.push(outcome([product()], 'fallback'));
  const second = await h.intent(invalid, 'second-refine');
  const { price_min_fen, price_max_fen, ...withoutPrice } = BASE;
  void price_min_fen;
  void price_max_fen;
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([withoutPrice]);
  expect(noticeKeys(second.cards)).toEqual(['agent.notice.price_unrecognized']);
  expect(second.suggestions).toEqual([]);
});

it('[AC-B3-05g#11][BR-AI-08] 新搜索即使没有商品也开新链，旧商品引用仍然保留', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  const req = request({ agent_intent: 'clarify', slot: 'price' });
  const oldScope = await h.clarification.scope(req);
  expect(await h.clarification.takeOnce(oldScope, 'price')).toBe(true);
  h.replies.push(outcome([], 'empty-search', null, 1));
  const nextCtx = { ...h.ctx, runId: 'empty-search-run' };
  await h.call({ q: '合成另一品类' }, nextCtx);
  const nextScope = await h.clarification.scope({
    ...req,
    input: { ...req.input, runId: nextCtx.runId },
  });
  expect(nextScope.chainId).not.toBe(oldScope.chainId);
  expect(await h.clarification.takeOnce(nextScope, 'price')).toBe(true);
  expect(await h.references.resolve({ card_id: 'c2' }, h.quoteContext())).toEqual({
    kind: 'product',
    productKey: product().product_key,
  });
});

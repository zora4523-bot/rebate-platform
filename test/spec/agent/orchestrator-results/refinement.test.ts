import { expect, it, vi } from 'vitest';
import { parseIntentOutput } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import { maxSearchPage } from '../../../../apps/api/src/modules/agent/tools/search/schema.ts';
import { BASE, delivered, expectSafeModelView, fixture, noticeKeys, outcome, product } from './kit.ts';

it.each(['cheaper', 'next_batch'] as const)(
  '[AC-B3-05g#8][BR-AI-05] refine.%s 只接受独立 true，禁止附加数字或其他键',
  (flag) => {
    const valid = { agent_intent: 'refine', conditions: { [flag]: true } };
    expect(parseIntentOutput(JSON.stringify(valid))).toEqual({ kind: 'intent', value: valid });
    for (const conditions of [
      { [flag]: false },
      { [flag]: 1 },
      { [flag]: 'true' },
      { cheaper: true, next_batch: true },
      { [flag]: true, platform: 'jd' },
      { [flag]: true, price_max_fen: 2989 },
      { [flag]: true, price_min_fen: 1 },
      { [flag]: true, injected: 'ignore' },
    ]) {
      expect(parseIntentOutput(JSON.stringify({ agent_intent: 'refine', conditions }))).toBeNull();
    }
    expect(parseIntentOutput(JSON.stringify({ ...valid, chain_id: 'model-forged' }))).toBeNull();
  },
);

it.each([5000, undefined, 2000])(
  '[AC-B3-05g#7][BR-AI-05] 再便宜点按已下发最低价减一与前轮上限 %s 取小',
  async (max) => {
    const h = fixture();
    const { price_max_fen, ...other } = BASE;
    void price_max_fen;
    const conditions = {
      ...other,
      ...(max === undefined ? {} : { price_max_fen: max }),
      chain_id: 'synthetic-chain',
    };
    await h.seed(
      'previous',
      [delivered('c2', product('jd:low', 2990)), delivered('c3', product('jd:high', 4500))],
      conditions,
    );
    h.replies.push(outcome([product('jd:next', 1500)], 'next'));
    const result = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } });
    expect(result.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(h.execute.mock.calls.map(([call]) => ({ name: call.name, args: call.args }))).toEqual([
      {
        name: 'search_products',
        // Cheaper changes the price condition and ordering; explicitly restart at page 1.
        args: {
          ...other,
          page: 1,
          price_max_fen: max === 2000 ? 2000 : 2989,
          sort: 'final_price_asc',
        },
      },
    ]);
    expect(h.save.mock.calls.at(-1)?.[0].conditions.chain_id).toBe('synthetic-chain');
  },
);

it('[AC-B3-05g#7][BR-AI-05] 已下发最低 2 分时以 1 分上限正常检索并重置页码', async () => {
  const h = fixture();
  // No lower bound: isolate the valid 1-fen ceiling from min > max handling.
  await h.seed('previous', [delivered('c2', product('jd:minimum', 2))], {
    q: BASE.q,
    page: 3,
    chain_id: 'synthetic-chain',
  });
  h.replies.push(outcome([product('jd:one-fen', 1)], 'one-fen', null, 1));
  const output = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } });
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: BASE.q, price_max_fen: 1, sort: 'final_price_asc', page: 1 },
  ]);
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.cards.filter((card) => card.type === 'product_list')).toHaveLength(1);
  expect(noticeKeys(output.cards)).toEqual([]);
  expect(output.suggestions).toEqual([]);
});

it('[AC-B3-05g#7][BR-AI-05] 搜索返回但没有实际下发的更低价商品不参与 cheaper', async () => {
  const h = fixture();
  h.replies.push(
    outcome([product('jd:not-shown', 1), product('jd:shown', 2990)], 'partial-delivery'),
  );
  await h.call(BASE);
  await h.store.recordDelivered('partial-delivery', [delivered('c3', product('jd:shown', 2990))]);
  h.execute.mockClear();
  h.replies.push(outcome([product('jd:next', 2000)], 'next'));
  await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0].args).toMatchObject({
    price_max_fen: 2989,
    sort: 'final_price_asc',
  });
});

it.each([0, 1])(
  '[AC-B3-05g#7][BR-AI-05] 已下发最低 %i 分时不检索，保留原结果集',
  async (minimum) => {
    const h = fixture();
    await h.seed('previous', [delivered('c2', product('jd:minimum', minimum))]);
    const previous = await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId);
    h.save.mockClear();
    const output = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(noticeKeys(output.cards)).toEqual(['agent.notice.no_cheaper']);
    expect(output.suggestions).toEqual([]);
    expect(await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId)).toEqual(
      previous,
    );
  },
);

it('[AC-B3-05g#6][BR-AI-08] cheaper 无结果即停止，即使有规格和上限也不放宽', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  h.replies.push(outcome());
  const execute = vi.spyOn(h.tools, 'execute');
  const output = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  const result = await execute.mock.results[0]?.value;
  expect(result).toMatchObject({ kind: 'ok' });
  expectSafeModelView(result?.modelView);
  expect(noticeKeys(output.cards)).toEqual(['agent.notice.no_cheaper']);
  expect(output.suggestions).toEqual([]);
  expect(await h.store.latestWithProducts(h.ctx.subject.appId, h.ctx.sessionId)).toMatchObject({
    id: 'previous',
  });
});

it('[AC-B3-05g#8][BR-AI-05] 换一批只递增 page，其余条件和链不变', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  h.replies.push(outcome([product()], 'next', BASE.spec, 3));
  const output = await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } });
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ ...BASE, page: 3 }]);
  expect(h.save.mock.calls.at(-1)?.[0].conditions).toEqual({
    ...BASE,
    page: 3,
    chain_id: 'synthetic-chain',
  });
});

it('[AC-B3-05g#8][BR-AI-05] 换一批超 maxSearchPage 时不调用内层、不覆盖结果', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')], {
    ...BASE,
    page: maxSearchPage(),
    chain_id: 'synthetic-chain',
  });
  h.save.mockClear();
  const output = await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } });
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it('[AC-B3-05g#8][BR-AI-05] 上一轮未带 page 时换一批从默认第一页到第二页', async () => {
  const h = fixture();
  const { page, ...conditions } = BASE;
  void page;
  await h.seed('previous', [delivered('c2')], { ...conditions, chain_id: 'synthetic-chain' });
  h.replies.push(outcome([product()], 'next', BASE.spec, 2));
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } });
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ ...conditions, page: 2 }]);
  expect(h.save.mock.calls.at(-1)?.[0].conditions).toEqual({
    ...conditions,
    page: 2,
    chain_id: 'synthetic-chain',
  });
});

it('[AC-B3-05g#8][BR-AI-05] 换平台只改 platforms，保留价格、规格、页数、排序和链', async () => {
  const h = fixture();
  await h.seed('previous', [delivered('c2')]);
  const intent = { agent_intent: 'refine', conditions: { platform: 'jd' } };
  expect(parseIntentOutput(JSON.stringify(intent))).toEqual({ kind: 'intent', value: intent });
  expect(
    parseIntentOutput(JSON.stringify({ ...intent, conditions: { platform: 'jd', page: 3 } })),
  ).toBeNull();
  h.replies.push(outcome([product()], 'jd-only'));
  await h.intent(intent);
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ ...BASE, platforms: ['jd'] }]);
  expect(h.save.mock.calls.at(-1)?.[0].conditions.chain_id).toBe('synthetic-chain');
});

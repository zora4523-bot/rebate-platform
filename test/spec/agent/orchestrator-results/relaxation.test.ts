import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { readSearchParams } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import {
  BASE,
  cards,
  copy,
  expectSafeModelView,
  fixture,
  notice,
  noticeKeys,
  outcome,
  product,
} from './kit.ts';

it('[AC-B3-05g#4][BR-AI-08] 无结果按规格、价格上限依序放宽，保留下限，其余条件不变', async () => {
  const h = fixture();
  h.replies.push(outcome(), outcome([], 'step1', null), outcome([], 'step2', null));
  const result = await h.call(BASE);
  expectSafeModelView(result.modelView);
  const { spec, ...noSpec } = BASE;
  const { price_max_fen, ...noMax } = noSpec;
  void spec;
  void price_max_fen;
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([BASE, noSpec, noMax]);
  expect(noticeKeys(result)).toEqual([
    'agent.notice.relaxed_spec',
    'agent.notice.relaxed_price',
    'agent.notice.no_result',
  ]);
  expect(result).toMatchObject({
    suggestions: [1, 2, 3].map((n) => ({
      text: copy(`agent.suggest.no_result.${n}`),
      send_text: copy(`agent.suggest.no_result.${n}`),
    })),
  });
  expect(h.save).not.toHaveBeenCalled();
});

it('[AC-B3-05g#4][BR-AI-08] 规格放宽已有商品就停止，整组 notice 与商品一起交付', async () => {
  const h = fixture();
  h.replies.push(outcome(), outcome([product()], 'step1', null));
  const result = await h.call(BASE);
  expectSafeModelView(result.modelView);
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect(noticeKeys(result)).toEqual(['agent.notice.relaxed_spec']);
  expect(cards(result).filter((c) => c.type === 'product_list')).toHaveLength(1);
});

it('[AC-B3-05g#4][BR-AI-08] 没有规格跳过第一步不消耗调用，只有下限时不放宽下限', async () => {
  const h = fixture();
  const args = { q: '合成商品', price_min_fen: 100, price_max_fen: 5000 };
  h.replies.push(outcome([], 'original', null, 1), outcome([], 'step2', null, 1));
  const result = await h.call(args);
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    args,
    { q: '合成商品', price_min_fen: 100 },
  ]);
  expect(noticeKeys(result)).toEqual(['agent.notice.relaxed_price', 'agent.notice.no_result']);
  h.reset();
  h.replies.push(outcome([], 'only-min', null, 1));
  const onlyMin = await h.call({ q: '合成商品', price_min_fen: 100 });
  expectSafeModelView(onlyMin.modelView);
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(noticeKeys(onlyMin)).toEqual(['agent.notice.no_result']);
});

it('[AC-B3-05g#4][BR-AI-08] 窄化读取 search_params：合法元数据可读，缺失和错误类型返回 null', () => {
  expect(
    readSearchParams({ search_params: { spec: '24盒', page: 2 }, link_registrations: [] }),
  ).toEqual({ spec: '24盒', page: 2 });
  expect(readSearchParams({ search_params: { spec: null, page: 1 } })).toEqual({
    spec: null,
    page: 1,
  });
  for (const value of [
    undefined,
    null,
    [],
    {},
    { spec: '24盒', page: 1 },
    { search_params: null },
    { search_params: [] },
    { search_params: { spec: 24, page: 1 } },
    { search_params: { spec: null, page: '1' } },
    { search_params: { page: 1 } },
  ]) {
    expect(readSearchParams(value)).toBeNull();
  }
});

it('[AC-B3-05g#4][BR-AI-08] 放宽依据 handler 的实际 spec，不把原始请求当有效元数据', async () => {
  const h = fixture();
  // Simulate the handler normalizing an absent/ignored spec. Only the trace is authoritative.
  h.replies.push(
    outcome([], 'normalized', null, 2),
    outcome([product()], 'price-relaxed', null, 2),
  );
  const result = await h.call(BASE);
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect(h.execute.mock.calls[1]?.[0].args).not.toHaveProperty('price_max_fen');
  expect(noticeKeys(result)).toEqual(['agent.notice.relaxed_price']);
});

it.each([2, 3])(
  '[AC-B3-05g#5][BR-AI-08] 已用 %i 次时工具预算不足就停止放宽并出无结果提示',
  async (used) => {
    const h = fixture();
    for (let i = 0; i < used; i += 1) await h.call({}, h.ctx, 'search_rules');
    const result = await h.call(BASE);
    expect(h.execute).toHaveBeenCalledTimes(4);
    expect(noticeKeys(result)).toEqual(
      used === 2
        ? ['agent.notice.relaxed_spec', 'agent.notice.no_result']
        : ['agent.notice.no_result'],
    );
    expect(result.kind === 'ok' ? result.suggestions : null).toHaveLength(3);
    const exhausted = await h.call({}, h.ctx, 'get_rebate_quote');
    expect(exhausted.kind).toBe('failed');
    expect(h.execute).toHaveBeenCalledTimes(4);
  },
);

it('[AC-B3-05g#5][BR-AI-08] 属性：每轮模型调用与追加调用共用四次预算，新 run 独立计数', async () => {
  const h = fixture();
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (used) => {
      h.reset();
      for (let i = 0; i < used; i += 1) await h.call({}, h.ctx, 'search_rules');
      const result = await h.call(BASE);
      expect(h.execute).toHaveBeenCalledTimes(Math.min(used + 3, 4));
      expect(noticeKeys(result)).toContain('agent.notice.no_result');
      for (let i = h.execute.mock.calls.length; i < 4; i += 1)
        await h.call({}, h.ctx, 'search_rules');
      expect((await h.call(BASE)).kind).toBe('failed');
      expect(h.execute).toHaveBeenCalledTimes(4);
      h.replies.push(outcome([product()], 'new-run'));
      expect((await h.call(BASE, { ...h.ctx, runId: 'new-run' })).kind).toBe('ok');
      expect(h.execute).toHaveBeenCalledTimes(5);
    }),
    propParams(),
  );
}, 60_000);

it('[AC-B3-05g#6][BR-AI-08] 禁售的空结果原样返回，不放宽、不发普通无结果提示', async () => {
  const h = fixture();
  const refused = {
    kind: 'ok' as const,
    modelView: { items: [], refused: 'prohibited' },
    cards: [notice('agent.refuse.prohibited')],
  };
  h.replies.push(refused);
  expect(await h.call(BASE)).toEqual(refused);
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.save).not.toHaveBeenCalled();
});

it('[AC-B3-05g#6][BR-AI-08] 失败或参数拒绝不是无结果，不追加检索', async () => {
  const h = fixture();
  const failed = { kind: 'failed' as const, modelView: { error: 'tool_failed' } };
  const rejected = { kind: 'rejected' as const, modelView: { error: 'invalid_args' as const } };
  for (const reply of [failed, rejected]) {
    h.reset();
    h.replies.push(reply);
    expect(await h.call(BASE)).toEqual(reply);
    expect(h.execute).toHaveBeenCalledTimes(1);
  }
});

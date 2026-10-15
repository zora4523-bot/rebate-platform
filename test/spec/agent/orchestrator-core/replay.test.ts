import { expect, it, vi } from 'vitest';
import { filteredText } from './fixtures/recordings.ts';
import { input, notice, proceed, referenceView, setup, toolCall } from './kit.ts';

it('[AC-B3-05b#1][BR-AI-06] 跨 delta 金额与 URL 经真 OutputGuard 过滤，第三句丢弃并记录命中', async () => {
  const r = setup([filteredText]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.text()).toBe('只要见卡片，点 。可看卡片。');
  expect(r.review).toHaveBeenCalled();
  expect(r.traces.at(-1)).toMatchObject({
    output_filtered: true,
    output_truncated: true,
    filter_hits: expect.arrayContaining(['amount', 'url']),
  });
  expect(r.content().every((e) => e.kind === 'text')).toBe(true);
  r.replayed();
});

it('[AC-B3-05b#2][BR-AI-06] run 收尾过滤未成句的尾巴，不把金额拆开漏出', async () => {
  const r = setup([{ parts: ['合成说明只要29.', '9元'] }]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.text()).toBe('合成说明只要见卡片');
  expect(r.review).toHaveBeenCalledTimes(1);
  r.replayed();
});

it('[AC-B3-05b#3][BR-AI-06][BR-AI-05] 工具状态模板、顺序出卡、第二轮仅回传 modelView 且命中录制', async () => {
  const cards = [notice('合成第一卡'), notice('合成第二卡')];
  const calls = [toolCall('synthetic-call-a'), toolCall('synthetic-call-b', { q: '合成第二查询' })];
  const secondView = { ref: 'synthetic-card-b' };
  const r = setup(
    [
      { parts: ['先看卡片。'], calls, views: [referenceView, secondView] },
      { parts: ['也可看看另一款。'] },
    ],
    {
      outcomes: [
        { kind: 'ok', modelView: referenceView, cards: [cards[0]!] },
        { kind: 'ok', modelView: secondView, cards: [cards[1]!] },
      ],
    },
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.events.filter((e) => e.kind !== 'text')).toEqual([
    {
      kind: 'status',
      tool: 'search_products',
      phase: 'start',
      display: '模板:search_products:start',
    },
    { kind: 'status', tool: 'search_products', phase: 'end', display: '模板:search_products:end' },
    { kind: 'card', card: cards[0] },
    {
      kind: 'status',
      tool: 'search_products',
      phase: 'start',
      display: '模板:search_products:start',
    },
    { kind: 'status', tool: 'search_products', phase: 'end', display: '模板:search_products:end' },
    { kind: 'card', card: cards[1] },
  ]);
  expect(r.text()).toBe('先看卡片。也可看看另一款。');
  expect(r.deps.tools.definitions).toHaveBeenCalledWith(input().caller);
  expect(r.execute.mock.calls[0]).toEqual([
    { id: 'synthetic-call-a', name: 'search_products', args: { q: '合成保温杯' } },
    expect.objectContaining({
      subject: input().caller,
      signal: r.ctx.signal,
      runId: input().runId,
      sessionId: input().sessionId,
      placeholders: {},
    }),
  ]);
  expect(r.complete.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
  expect(r.complete.mock.calls[1]?.[1].clock).toBe(r.complete.mock.calls[0]?.[1].clock);
  expect(JSON.stringify(r.requests)).not.toContain('合成第一卡');
  expect(r.complete).toHaveBeenCalledTimes(2);
  r.replayed();
});

it('[AC-B3-05b#4][BR-AI-06] 工具失败显示 failed 模板并把失败模型视图传回，循环继续', async () => {
  const view = { error: 'synthetic_unavailable' };
  const r = setup(
    [{ calls: [toolCall('synthetic-failed')], views: [view] }, { parts: ['稍后可以再试。'] }],
    {
      outcomes: [{ kind: 'failed', modelView: view }],
    },
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.events.filter((e) => e.kind === 'status').map((e) => [e.phase, e.display])).toEqual([
    ['start', '模板:search_products:start'],
    ['failed', '模板:search_products:failed'],
  ]);
  expect(r.events.filter((e) => e.kind === 'card')).toEqual([]);
  expect(r.traces.at(-1)?.tool_calls).toEqual([
    { name: 'search_products', args: { q: '合成保温杯' }, status: 'failed' },
  ]);
  r.replayed();
});

it('[AC-B3-05b#5][BR-AI-03][BR-AI-06] 身份字段原样交注册端口拒绝，不删字段重试或触发副作用', async () => {
  const args = {
    q: '合成查询',
    user_id: 'synthetic-forged',
    nested: { app_id: 'synthetic-forged-app' },
  };
  const denied = { error: 'invalid_args' as const };
  const r = setup([
    { calls: [toolCall('synthetic-reject', args)], views: [denied] },
    { parts: ['请按正常方式查询。'] },
  ]);
  const sideEffect = vi.fn();
  r.execute.mockImplementation(async (call) => {
    if ((call.args as Record<string, unknown>)['user_id'] !== undefined)
      return { kind: 'rejected', modelView: denied };
    sideEffect();
    return { kind: 'ok', modelView: {}, cards: [] };
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.execute).toHaveBeenCalledTimes(1);
  expect(r.execute.mock.calls[0]?.[0].args).toEqual(args);
  expect(sideEffect).not.toHaveBeenCalled();
  expect(r.events.filter((e) => e.kind === 'card')).toEqual([]);
  expect(r.traces.at(-1)?.tool_calls).toEqual([
    { name: 'search_products', args, status: 'rejected' },
  ]);
  r.replayed();
});

it('[AC-B3-05b#6][BR-AI-14][BR-AI-06] trace 保留模型占位参数与意图，不恢复用户长数字', async () => {
  const value = input();
  const raw = '987654321012345678';
  const args = { q: '合成订单<num_1>', extra: ['<num_1>'] };
  const r = setup(
    [
      { calls: [toolCall('synthetic-trace-call', args)], views: [{}] },
      { parts: ['{"agent_intent":"out_of_scope"}'] },
    ],
    {
      proceed: proceed({ modelText: '合成订单<num_1>', placeholders: { '<num_1>': raw } }),
    },
  );
  expect(await r.run({}, { ...value, text: `合成订单${raw}` })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(r.traces.at(-1)).toMatchObject({
    intent: 'out_of_scope',
    tool_calls: [{ name: 'search_products', args, status: 'ok' }],
  });
  expect(JSON.stringify(r.traces)).not.toContain(raw);
  expect(JSON.stringify(r.requests)).not.toContain(raw);
  expect(r.text()).toBe('固定文案:agent.refuse.out_of_scope');
  r.replayed();
});

it('[AC-B3-05b#7][BR-AI-06] 句数上限贯穿工具前后，不在每轮模型调用重置', async () => {
  const r = setup([
    { parts: ['第一句。第二句。'], calls: [toolCall('synthetic-three')], views: [{}] },
    { parts: ['第三句不能显示。'] },
  ]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.text()).toBe('第一句。第二句。');
  expect(r.traces.at(-1)?.output_truncated).toBe(true);
  r.replayed();
});

it('[AC-B3-05b#8][BR-AI-06] 输出审核命中即停止，同轮未发工具和卡片不再执行', async () => {
  const r = setup(
    [{ parts: ['合成被拦句。'], calls: [toolCall('synthetic-blocked')], views: [{}] }],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [notice()] }] },
  );
  r.review.mockResolvedValue('block');
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'safety' });
  expect(r.text()).toBe('固定文案:agent.refuse.output_blocked');
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.events.filter((e) => e.kind === 'card')).toEqual([]);
  expect(r.complete).toHaveBeenCalledTimes(1);
  r.replayed();
});

it('[AC-B3-05b#9][BR-AI-06] 后续轮审核命中，已发卡片保留且不再生成', async () => {
  const card = notice('已发合成卡');
  const r = setup(
    [{ calls: [toolCall('synthetic-card')], views: [{}] }, { parts: ['合成拦截文本。'] }],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [card] }] },
  );
  r.review.mockResolvedValue('block');
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'safety' });
  expect(r.events.filter((e) => e.kind === 'card')).toEqual([{ kind: 'card', card }]);
  expect(r.text()).toBe('固定文案:agent.refuse.output_blocked');
  r.replayed();
});

it('[AC-B3-05b#10][BR-AI-06] 审核两次超时替换剩余文字，工具卡片仍照常下发', async () => {
  const card = notice('超时仍出合成卡');
  const r = setup(
    [
      { parts: ['合成未审文字。'], calls: [toolCall('synthetic-timeout')], views: [{}] },
      { parts: ['合成剩余文字。'] },
    ],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [card] }] },
  );
  r.review.mockResolvedValue('timeout');
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.text()).toBe('固定文案:agent.refuse.safety_timeout');
  expect(r.review).toHaveBeenCalledTimes(2);
  expect(r.events.filter((e) => e.kind === 'card')).toEqual([{ kind: 'card', card }]);
  r.replayed();
});

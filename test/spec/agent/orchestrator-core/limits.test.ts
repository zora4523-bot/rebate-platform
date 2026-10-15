import { expect, it } from 'vitest';
import { orchestratorLimitsDefaults } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { notice, productList, setup, toolCall } from './kit.ts';

it('[AC-B3-05b#22][BR-AI-14] 默认五项上限逐项等于 SPEC_REF 的 02 §9.1–9.2', () => {
  expect(orchestratorLimitsDefaults()).toEqual({
    toolCalls: 4,
    modelRounds: 3,
    textCodePoints: 20000,
    cards: 12,
    contentFrames: 400,
  });
});

it('[AC-B3-05b#23][BR-AI-14] 同轮五个工具只执行前四个，越界工具不写状态或卡片', async () => {
  const calls = Array.from({ length: 5 }, (_, i) => toolCall(`synthetic-limit-${i}`));
  const r = setup([{ calls, views: calls.map(() => ({})) }]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.execute.mock.calls.map(([call]) => call.id)).toEqual(
    calls.slice(0, 4).map((call) => call.id),
  );
  expect(r.events.filter((e) => e.kind === 'status')).toHaveLength(8);
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.degraded).not.toHaveBeenCalled();
  r.replayed();
});

it('[AC-B3-05b#24][BR-AI-14] 工具上限跨模型轮累计，不因下一轮重置', async () => {
  const r = setup([
    {
      calls: [toolCall('synthetic-a'), toolCall('synthetic-b'), toolCall('synthetic-c')],
      views: [{}, {}, {}],
    },
    { calls: [toolCall('synthetic-d'), toolCall('synthetic-e')], views: [{}, {}] },
  ]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.execute.mock.calls.map(([call]) => call.id)).toEqual([
    'synthetic-a',
    'synthetic-b',
    'synthetic-c',
    'synthetic-d',
  ]);
  expect(r.complete).toHaveBeenCalledTimes(2);
  r.replayed();
});

it('[AC-B3-05b#25][BR-AI-14] 第三次模型往返仍请求工具，以 limit 结束且没有第四次模型调用', async () => {
  const r = setup(
    Array.from({ length: 3 }, (_, i) => ({
      calls: [toolCall(`synthetic-round-${i}`)],
      views: [{}],
    })),
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.complete).toHaveBeenCalledTimes(3);
  expect(r.execute.mock.calls.length).toBeLessThanOrEqual(3);
  expect(r.degraded).not.toHaveBeenCalled();
  r.replayed();
});

it('[AC-B3-05b#26][BR-AI-06][BR-AI-14] 累计输出按 Unicode 码点到 20000 截断，不按 UTF-16 长度提前停止', async () => {
  const r = setup([{ parts: ['😀'.repeat(20001)] }]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.text()).toBe('😀'.repeat(20000));
  expect(Array.from(r.text())).toHaveLength(20000);
  expect(r.content().length).toBeLessThanOrEqual(400);
  r.replayed();
});

it('[AC-B3-05b#27][BR-AI-06][BR-AI-14] 工具返回十三张卡只发十二张，后续模型与 suggestions 不再写出', async () => {
  const cards = Array.from({ length: 13 }, (_, i) => notice(`合成卡${i}`));
  const r = setup([{ calls: [toolCall('synthetic-cards')], views: [{}] }], {
    outcomes: [
      {
        kind: 'ok',
        modelView: {},
        cards,
        suggestions: [{ text: '合成建议', send_text: '合成后续' }],
      },
    ],
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.content()).toEqual(cards.slice(0, 12).map((card) => ({ kind: 'card', card })));
  expect(r.complete).toHaveBeenCalledTimes(1);
  r.replayed();
});

it('[AC-B3-05b#28][BR-AI-06][BR-AI-14] 内嵌商品占卡片额度，容器和商品合计到上限即停', async () => {
  const cards = [productList(8), productList(2), notice('不应再发')];
  const r = setup([{ calls: [toolCall('synthetic-embedded-limit')], views: [{}] }], {
    outcomes: [{ kind: 'ok', modelView: {}, cards }],
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.content()).toEqual(cards.slice(0, 2).map((card) => ({ kind: 'card', card })));
  r.replayed();
});

it('[AC-B3-05b#29][BR-AI-06][BR-AI-14] 内嵌商品不计内容帧，tool.status 也不消耗帧数', async () => {
  const card = productList(3);
  const r = setup(
    [{ calls: [toolCall('synthetic-frame-count')], views: [{}] }, { parts: ['可看卡片。'] }],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [card] }] },
  );
  expect(await r.run({ limits: { ...r.deps.limits, contentFrames: 3 } })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(r.content()).toEqual([
    { kind: 'card', card },
    { kind: 'text', text: '可看卡片。' },
  ]);
  expect(r.events.filter((e) => e.kind === 'status')).toHaveLength(2);
  r.replayed();
});

it('[AC-B3-05b#30][BR-AI-06][BR-AI-14] card、suggestions、text.delta 共用内容帧额度，恰好到界立即 limit', async () => {
  const suggestions = [{ text: '合成建议', send_text: '合成后续' }];
  const card = notice();
  const r = setup(
    [{ calls: [toolCall('synthetic-content')], views: [{}] }, { parts: ['第一句。第二句。'] }],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [card], suggestions }] },
  );
  expect(await r.run({ limits: { ...r.deps.limits, contentFrames: 3 } })).toEqual({
    kind: 'done',
    finishReason: 'limit',
  });
  expect(r.content()).toEqual([
    { kind: 'card', card },
    { kind: 'suggestions', items: suggestions },
    { kind: 'text', text: '第一句。' },
  ]);
  r.replayed();
});

it('[AC-B3-05b#31][BR-AI-14] 降级端口也受输出额度约束，返回值不能覆盖已触发的 limit', async () => {
  const r = setup([], { budget: true });
  r.degraded.mockImplementation(async (_request, ctx) => {
    ctx.text('合成第一段');
    await ctx.card(notice());
    ctx.suggestions([{ text: '不应显示', send_text: '不应显示' }]);
    ctx.text('不应显示');
    return { kind: 'done', finishReason: 'budget' };
  });
  expect(await r.run({ limits: { ...r.deps.limits, contentFrames: 2 } })).toEqual({
    kind: 'done',
    finishReason: 'limit',
  });
  expect(r.content()).toEqual([
    { kind: 'text', text: '合成第一段' },
    { kind: 'card', card: notice() },
  ]);
});

it('[AC-B3-05b#32][BR-AI-06] suggestions 只能来自服务端工具，最多三条', async () => {
  const items = Array.from({ length: 4 }, (_, i) => ({
    text: `合成建议${i}`,
    send_text: `合成后续${i}`,
  }));
  const r = setup(
    [{ calls: [toolCall('synthetic-suggestions')], views: [{}] }, { parts: ['请看卡片。'] }],
    { outcomes: [{ kind: 'ok', modelView: {}, cards: [], suggestions: items }] },
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.events.filter((e) => e.kind === 'suggestions')).toEqual([
    { kind: 'suggestions', items: items.slice(0, 3) },
  ]);
  r.replayed();
});

it('[AC-B3-05b#43][BR-AI-06][BR-AI-14] 同轮两个工具各返回八件商品，卡片累计上限不按工具重置', async () => {
  // 02 §9.2: 12 total, including container. Two product_list(8) cost 9 + 9;
  // the second whole card cannot fit and must not be partially emitted.
  const first = productList(8);
  const second = { ...productList(8), fallback_text: '合成第二批' };
  const r = setup(
    [
      {
        calls: [toolCall('synthetic-eight-a'), toolCall('synthetic-eight-b')],
        views: [{}, {}],
      },
    ],
    {
      outcomes: [
        { kind: 'ok', modelView: {}, cards: [first] },
        {
          kind: 'ok',
          modelView: {},
          cards: [second],
          suggestions: [{ text: '不应显示', send_text: '不应显示' }],
        },
      ],
    },
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.content()).toEqual([{ kind: 'card', card: first }]);
  expect(r.execute).toHaveBeenCalledTimes(2);
  expect(r.complete).toHaveBeenCalledTimes(1);
  r.replayed();
});

it('[AC-B3-05b#44][BR-AI-06][BR-AI-14] 跨两轮工具的卡片恰到十二张即停，不重新分配额度', async () => {
  const cards = [productList(5), { ...productList(5), fallback_text: '合成下一轮' }];
  const r = setup(
    [
      { calls: [toolCall('synthetic-card-round-a')], views: [{}] },
      { calls: [toolCall('synthetic-card-round-b')], views: [{}] },
    ],
    {
      outcomes: cards.map((card) => ({
        kind: 'ok',
        modelView: {},
        cards: [card],
      })),
    },
  );
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.content()).toEqual(cards.map((card) => ({ kind: 'card', card })));
  expect(r.complete).toHaveBeenCalledTimes(2);
  expect(r.execute).toHaveBeenCalledTimes(2);
  r.replayed();
});

it('[AC-B3-05b#45][BR-AI-06][BR-AI-14] 工具前后两轮文字累计封顶二万码点', async () => {
  // No sentence delimiter: sentence count cannot conceal a per-round text counter bug.
  const r = setup([
    { parts: ['😀'.repeat(15000)], calls: [toolCall('synthetic-text-round')], views: [{}] },
    { parts: ['🦊'.repeat(10000)] },
  ]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.text()).toBe('😀'.repeat(15000) + '🦊'.repeat(5000));
  expect(Array.from(r.text())).toHaveLength(20000);
  expect(r.content().length).toBeLessThanOrEqual(400);
  expect(r.complete).toHaveBeenCalledTimes(2);
  expect(r.execute).toHaveBeenCalledTimes(1);
  expect(r.events.at(-1)?.kind).toBe('text');
  r.replayed();
});

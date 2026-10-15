import { expect, it } from 'vitest';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ModelOutcome } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { notice, setup, toolCall } from './kit.ts';

// Drain promise continuations only; no wall-clock waits, fake timers or running services.
async function microtasks(): Promise<void> {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

it('[AC-B3-05b#33][BR-AI-14] 已取消的 run 不检查输入、不调模型或工具、不写任何内容', async () => {
  const r = setup();
  r.controller.abort('cancelled');
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.events).toEqual([]);
  expect(r.check).not.toHaveBeenCalled();
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05b#34][BR-AI-14] 模型持有同一 signal，取消后尽快返回并丢弃晚到的工具与文本', async () => {
  const r = setup();
  const late = Promise.withResolvers<ModelOutcome>();
  r.complete.mockImplementation(async () => late.promise);
  let settled = false;
  const pending = r.run().then((result) => {
    settled = true;
    return result;
  });
  await microtasks();
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.complete.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
  r.controller.abort('cancelled');
  await microtasks();
  const returnedBeforeModel = settled;
  late.resolve({
    kind: 'model',
    entryId: 'flash',
    model: 'qwen-flash-2026-09-01',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [],
    events: [
      { t: 'text_delta', text: '不应显示。' },
      { t: 'tool_call', index: 0, call: toolCall('synthetic-late') },
      { t: 'done', reason: 'tool_calls' },
    ],
  });
  await pending;
  await microtasks();
  expect(returnedBeforeModel).toBe(true);
  expect(r.events).toEqual([]);
  expect(r.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05b#35][BR-AI-14] 工具收到同一 signal，取消后不写 end、卡片或 suggestions', async () => {
  const r = setup([{ calls: [toolCall('synthetic-pending-tool')], views: [{}] }]);
  const late = Promise.withResolvers<ToolOutcome>();
  r.execute.mockImplementation(async () => late.promise);
  let settled = false;
  const pending = r.run().then((result) => {
    settled = true;
    return result;
  });
  await microtasks();
  expect(r.execute).toHaveBeenCalledTimes(1);
  expect(r.execute.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
  const before = structuredClone(r.events);
  r.controller.abort('cancelled');
  await microtasks();
  const returnedBeforeTool = settled;
  late.resolve({
    kind: 'ok',
    modelView: {},
    cards: [notice('晚到卡')],
    suggestions: [{ text: '晚到建议', send_text: '晚到问题' }],
  });
  await pending;
  await microtasks();
  expect(returnedBeforeTool).toBe(true);
  expect(before).toEqual([
    {
      kind: 'status',
      tool: 'search_products',
      phase: 'start',
      display: '模板:search_products:start',
    },
  ]);
  expect(r.events).toEqual(before);
  expect(r.complete).toHaveBeenCalledTimes(1);
  r.replayed();
});

it('[AC-B3-05b#36][BR-AI-06][BR-AI-14] 按句审核期间取消，审核晚到也不下发文本', async () => {
  const r = setup([{ parts: ['合成待审核文字。'] }]);
  const late = Promise.withResolvers<'pass'>();
  r.review.mockImplementation(async () => late.promise);
  const pending = r.run();
  await microtasks();
  expect(r.review).toHaveBeenCalledTimes(1);
  r.controller.abort('cancelled');
  late.resolve('pass');
  await pending;
  expect(r.events).toEqual([]);
  r.replayed();
});

it('[AC-B3-05b#37][BR-AI-14] 下游降级端口持有的上下文在取消后屏蔽全部输出入口', async () => {
  const r = setup([], { budget: true });
  r.degraded.mockImplementation(async (_request, ctx) => {
    r.controller.abort('cancelled');
    ctx.text('不应显示');
    await ctx.card(notice());
    ctx.toolStatus('search_products', 'end', '不应显示');
    ctx.suggestions([{ text: '不应显示', send_text: '不应显示' }]);
    return { kind: 'done', finishReason: 'budget' };
  });
  await r.run();
  expect(r.events).toEqual([]);
});

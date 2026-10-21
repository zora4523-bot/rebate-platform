import { expect, it, vi } from 'vitest';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import type { LinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { proceed, setup } from '../orchestrator-core/kit.ts';
import { quotes, success, url } from '../orchestrator-deterministic/kit.ts';

it('[AC-B3-05j#1][BR-AI-21] 真确定性路径只记录一份无模型 trace，意图为 find_by_link', async () => {
  const base = setup([], { proceed: proceed({ links: [url(1)] }) });
  const record = vi.fn(base.deps.trace!.record);
  const deterministic = createDeterministicPath({ quotes: quotes(), texts: base.deps.texts });
  expect(await base.run({ deterministic, trace: { record } })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(
    'synthetic-run',
    expect.objectContaining({
      intent: 'find_by_link',
      model: null,
      prompt_version: 'none',
      attempts: [],
    }),
  );
  expect(base.complete).not.toHaveBeenCalled();
  expect(base.deps.prompt.current).not.toHaveBeenCalled();
});

it('[AC-B3-05j#2][BR-AI-21] URL 顺序与完成状态入 trace，口令不计且序号仍按原链接位置', async () => {
  const links = [
    { kind: 'tpwd' as const, raw: '￥synthetic-token￥', index: 0 },
    url(9, 20),
    url(2, 80),
    url(7, 140),
    url(3, 200),
    url(1, 260),
  ];
  const base = setup([], { proceed: proceed({ links }) });
  const runner = quotes([
    success(9),
    { kind: 'parse_error', error_code: 30131, cards: [] },
    { kind: 'price_unavailable', cards: [] },
    { kind: 'no_card', cards: [] },
    new Error('synthetic runner failure'),
  ]);
  const deterministic = createDeterministicPath({ quotes: runner, texts: base.deps.texts });
  // §9 默认：确定性报价不占模型工具次数；此处故意低于 URL 数量。
  expect(await base.run({ deterministic, limits: { ...base.deps.limits, toolCalls: 1 } })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(base.traces).toHaveLength(1);
  expect(base.traces[0]!.tool_calls).toEqual([
    { name: 'get_rebate_quote', args: { link_index: 2 }, status: 'ok' },
    { name: 'get_rebate_quote', args: { link_index: 3 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 4 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 5 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 6 }, status: 'failed' },
  ]);
  expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual(links.slice(1));
  expect(base.execute).not.toHaveBeenCalled();
});

it.each(['return', 'throw'] as const)(
  '[AC-B3-05j#3][BR-AI-14] traceMask %s：只接收合成序号与本轮占位表，脱敏结果原样或 null',
  async (mode) => {
    // BR-AI-14 脱敏；BR-AI-19 仅为一跳背景，不额外规定存储行为。
    const placeholders = { '<num_1>': '3812345678901234567' };
    const link = { ...url(1), raw: 'https://item.example.invalid/syn/1?sharer=synthetic-private' };
    const base = setup([], { proceed: proceed({ links: [link], placeholders }) });
    const masked = Object.freeze({ safe: 'synthetic-masked', nested: { tag: 'safe' } });
    const traceMask = vi.fn<AgentRunBodyDeps['traceMask']>(() => {
      if (mode === 'throw') throw new Error(`synthetic mask error ${placeholders['<num_1>']}`);
      return masked;
    });
    const deterministic = createDeterministicPath({ quotes: quotes(), texts: base.deps.texts });
    expect(await base.run({ deterministic, traceMask })).toEqual({
      kind: 'done',
      finishReason: 'stop',
    });
    expect(traceMask.mock.calls).toEqual([[{ link_index: 1 }, placeholders]]);
    expect(base.traces).toHaveLength(1);
    expect(base.traces[0]!.tool_calls).toEqual([
      { name: 'get_rebate_quote', args: mode === 'throw' ? null : masked, status: 'ok' },
    ]);
    expect(base.traces[0]!.tool_calls[0]!.args).toBe(mode === 'throw' ? null : masked);
    expect(JSON.stringify(base.traces)).not.toContain(placeholders['<num_1>']);
    expect(JSON.stringify(base.traces)).not.toContain(link.raw);
    expect(JSON.stringify(base.traces)).not.toContain('synthetic-private');
  },
);

it('[AC-B3-05j#4][BR-AI-21] 缺少确定性端口仍标记链接意图，空提示不虚构工具调用', async () => {
  const base = setup([], { proceed: proceed({ links: [url(1)] }) });
  expect(await base.run()).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(base.events).toEqual([
    {
      kind: 'card',
      card: expect.objectContaining({
        type: 'notice',
        data: expect.objectContaining({ text_key: 'agent.degraded.empty' }),
      }),
    },
  ]);
  expect(base.traces).toEqual([
    expect.objectContaining({ intent: 'find_by_link', tool_calls: [] }),
  ]);
  expect(base.complete).not.toHaveBeenCalled();
});

it.each([false, true])(
  '[AC-B3-05j#6][BR-AI-21] start 后取消：已完成首条=%s，只记完成对且迟到结果不改 trace',
  async (completedFirst) => {
    const base = setup([], { proceed: proceed({ links: [url(1), url(2), url(3)] }) });
    const pending = Promise.withResolvers<Awaited<ReturnType<LinkQuoteRunner['run']>>>();
    const started = Promise.withResolvers<void>();
    let callIndex = 0;
    const runner: LinkQuoteRunner = {
      run: vi.fn(async () => {
        callIndex += 1;
        if (completedFirst && callIndex === 1) return success(1);
        started.resolve();
        return pending.promise;
      }),
    };
    const path = createDeterministicPath({ quotes: runner, texts: base.deps.texts });
    let pathDone: Promise<unknown> | undefined;
    const running = base.run({
      deterministic: {
        run(request, ctx) {
          const result = path.run(request, ctx);
          pathDone = result;
          return result;
        },
      },
    });
    await started.promise;
    base.controller.abort();
    expect(await running).toEqual({ kind: 'done', finishReason: 'stop' });
    const snapshot = structuredClone(base.traces);
    const events = structuredClone(base.events);
    pending.resolve(success(2));
    await pathDone;
    expect(base.traces).toEqual(snapshot);
    expect(base.events).toEqual(events);
    expect(base.traces).toEqual([
      expect.objectContaining({
        intent: 'find_by_link',
        tool_calls: completedFirst
          ? [{ name: 'get_rebate_quote', args: { link_index: 1 }, status: 'ok' }]
          : [],
      }),
    ]);
    expect(runner.run).toHaveBeenCalledTimes(completedFirst ? 2 : 1);
  },
);

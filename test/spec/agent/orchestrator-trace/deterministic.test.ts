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

it('[AC-B3-05j#2][BR-AI-21] URL 顺序与完成状态入 trace，序号仍按原链接位置', async () => {
  const links = [
    { kind: 'tpwd' as const, raw: '￥synthetic-token￥', index: 0 },
    url(9, 20),
    url(2, 80),
    url(7, 140),
    url(3, 200),
    url(1, 260),
  ];
  const base = setup([], { proceed: proceed({ links }) });
  // B3-04j: answers by candidate, so the URL trace is the same whether the token goes to the
  // runner (B3-04g, it answers 30132) or not; the token's own entry is checked below when present.
  const byRaw = new Map<string, Awaited<ReturnType<LinkQuoteRunner['run']>> | Error>([
    [url(9, 20).raw, success(9)],
    [url(2, 80).raw, { kind: 'parse_error', error_code: 30131, cards: [] }],
    [url(7, 140).raw, { kind: 'price_unavailable', cards: [] }],
    [url(3, 200).raw, { kind: 'no_card', cards: [] }],
    [url(1, 260).raw, new Error('synthetic runner failure')],
  ]);
  const runner = {
    run: vi.fn<LinkQuoteRunner['run']>(async (candidate) => {
      if (candidate.kind !== 'url') return { kind: 'parse_error', error_code: 30132, cards: [] };
      const outcome = byRaw.get(candidate.raw);
      if (outcome === undefined) throw new Error('Unexpected quote call');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  const deterministic = createDeterministicPath({ quotes: runner, texts: base.deps.texts });
  // §9 默认：确定性报价不占模型工具次数；此处故意低于 URL 数量。
  expect(await base.run({ deterministic, limits: { ...base.deps.limits, toolCalls: 1 } })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(base.traces).toHaveLength(1);
  const calls = base.traces[0]!.tool_calls;
  const token = { name: 'get_rebate_quote', args: { link_index: 1 }, status: 'failed' };
  const isToken = (call: unknown) => JSON.stringify(call) === JSON.stringify(token);
  expect(calls.filter((call) => !isToken(call))).toEqual([
    { name: 'get_rebate_quote', args: { link_index: 2 }, status: 'ok' },
    { name: 'get_rebate_quote', args: { link_index: 3 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 4 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 5 }, status: 'failed' },
    { name: 'get_rebate_quote', args: { link_index: 6 }, status: 'failed' },
  ]);
  // The token's entry, when the path quotes it, comes first and only once.
  expect(calls.length === 5 || (calls.length === 6 && isToken(calls[0]))).toBe(true);
  expect(
    runner.run.mock.calls.map(([candidate]) => candidate).filter((c) => c.kind === 'url'),
  ).toEqual(links.slice(1));
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

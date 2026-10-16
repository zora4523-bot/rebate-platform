import { expect, it, vi } from 'vitest';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorTools,
  OrchestratorTrace,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ModelOutcome } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { AssembledToolCall } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { context, input, proceed } from '../orchestrator-core/kit.ts';
import { handler, setup } from './kit.ts';

function modelCall(id: string, args: string, name = 'search_products'): AssembledToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function modelRound(events: Extract<ModelOutcome, { kind: 'model' }>['events']): ModelOutcome {
  return {
    kind: 'model',
    entryId: 'flash',
    model: 'synthetic-model-snapshot',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
    events,
  };
}

function runWith(registry: OrchestratorTools, calls: readonly AssembledToolCall[]) {
  const traces: OrchestratorTrace[] = [];
  const rounds = [
    modelRound([
      ...calls.map((call, index) => ({ t: 'tool_call' as const, index, call })),
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]),
  ];
  const complete = vi.fn<AgentRunBodyDeps['model']['complete']>(async () => {
    const round = rounds.shift();
    if (round === undefined) throw new Error('Unexpected synthetic model round');
    return round;
  });
  const traceMask = vi.fn((args: unknown) => args); // 仅合成参数，测试接线，不替代脱敏策略。
  const deps: AgentRunBodyDeps = {
    model: { complete },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: registry,
    inputCheck: { check: async () => proceed() },
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => key, toolDisplay: async () => '合成工具提示' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: '合成系统提示' }) },
    // BR-AI-03：拒绝也计入单轮 4 次工具调用；其余数值沿用 B3-05b 测试夹具。
    limits: { toolCalls: 4, modelRounds: 3, textCodePoints: 20000, cards: 12, contentFrames: 400 },
    traceMask,
    trace: {
      record: (_run, trace) => {
        traces.push(trace);
      },
    },
  };
  return {
    complete,
    traces,
    traceMask,
    run: () => createAgentRunBody(deps)(input())(context().ctx),
  };
}

it('[AC-B3-04a#17][BR-AI-03] JSON 解析失败在编排边界拒绝，trace 保留原文且 handler 不执行', async () => {
  const target = handler();
  const { registry, warn } = setup([target]);
  const h = runWith(registry, [modelCall('synthetic-call', '{broken-json')]);
  expect(await h.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(target.run).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(h.traces).toHaveLength(1);
  expect(h.traces[0]?.tool_calls).toEqual([
    { name: 'search_products', status: 'rejected', args: '{broken-json' },
  ]);
  expect(h.complete.mock.calls[1]?.[0].messages).toContainEqual({
    role: 'tool',
    tool_call_id: 'synthetic-call',
    content: '{"error":"invalid_args"}',
  });
});

it('[AC-B3-04a#18][BR-AI-03] ok、rejected、failed 均按名称、状态及未经改写的参数进入 trace', async () => {
  const target = handler();
  const failing = handler('get_rebate_quote');
  failing.run.mockRejectedValue(new Error('synthetic-private-error'));
  const { registry, warn } = setup([target, failing]);
  const h = runWith(registry, [
    modelCall('synthetic-ok', '{"q":"合成牛奶"}'),
    modelCall('synthetic-rejected', '{"q":"合成牛奶","adzoneId":"synthetic-injected"}'),
    modelCall('synthetic-failed', '{"q":"合成报价"}', 'get_rebate_quote'),
  ]);
  expect(await h.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.traces).toHaveLength(1);
  expect(h.traces[0]?.tool_calls).toEqual([
    { name: 'search_products', status: 'ok', args: { q: '合成牛奶' } },
    {
      name: 'search_products',
      status: 'rejected',
      args: { q: '合成牛奶', adzoneId: 'synthetic-injected' },
    },
    { name: 'get_rebate_quote', status: 'failed', args: { q: '合成报价' } },
  ]);
  expect(target.run).toHaveBeenCalledTimes(1);
  expect(failing.run).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(h.traceMask).toHaveBeenCalledWith({ q: '合成牛奶', adzoneId: 'synthetic-injected' }, {});
  const messages = h.complete.mock.calls[1]?.[0].messages;
  expect(messages).toContainEqual({
    role: 'tool',
    tool_call_id: 'synthetic-rejected',
    content: '{"error":"invalid_args"}',
  });
  expect(JSON.stringify(messages)).not.toContain('synthetic-private-error');
});

it('[AC-B3-04a#19][BR-AI-03] 四次拒绝耗尽调用额度，第五次合法调用也不能执行', async () => {
  const target = handler();
  const { registry, warn } = setup([target]);
  const h = runWith(registry, [
    modelCall('synthetic-a', '{broken-json'),
    modelCall('synthetic-b', '{"q":"合成牛奶","user_id":"synthetic-attacker"}'),
    modelCall('synthetic-c', '{"q":"合成牛奶","color":"red"}'),
    modelCall('synthetic-d', '{}', 'page_guide'),
    modelCall('synthetic-e', '{"q":"合成牛奶"}'),
  ]);
  expect(await h.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(target.run).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(h.traces[0]?.tool_calls).toEqual([
    { name: 'search_products', status: 'rejected', args: '{broken-json' },
    {
      name: 'search_products',
      status: 'rejected',
      args: { q: '合成牛奶', user_id: 'synthetic-attacker' },
    },
    { name: 'search_products', status: 'rejected', args: { q: '合成牛奶', color: 'red' } },
    { name: 'page_guide', status: 'rejected', args: {} },
  ]);
});

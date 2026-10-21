import { expect, it, vi } from 'vitest';
import { createDegradedPath } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/index.ts';
import { input, proceed, setup, toolCall } from '../orchestrator-core/kit.ts';

it.each(['route_no_model', 'models_failed', 'budget'] as const)(
  '[AC-B3-05j#5][BR-AI-14] %s 降级默认 search，保留此前模型工具调用且不伪造关键词工具调用',
  async (reason) => {
    const prepared = proceed();
    const base = setup(
      [
        {
          calls: [
            toolCall('synthetic-ok', { q: '合成甲' }),
            toolCall('synthetic-failed', { q: '合成乙' }),
          ],
          views: [{}, { error: 'synthetic_unavailable' }],
        },
      ],
      {
        proceed: prepared,
        outcomes: [
          { kind: 'ok', modelView: {}, cards: [] },
          { kind: 'failed', modelView: { error: 'synthetic_unavailable' } },
        ],
      },
    );
    // 先通过真实录制完成一轮模型工具调用，再由路由端口报告降级。
    const original = base.complete.getMockImplementation()!;
    const complete = vi
      .fn(original)
      .mockImplementationOnce(original)
      .mockResolvedValue({ kind: 'degraded', reason, attempts: [] });
    const path = createDegradedPath({
      tools: base.deps.tools,
      texts: base.deps.texts,
      errorMsg: async () => '合成搜索不可用',
    });
    const run = vi.fn(path.run);
    expect(await base.run({ model: { complete }, degraded: { run } })).toEqual({
      kind: 'done',
      finishReason: reason === 'budget' ? 'budget' : 'fallback',
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ reason, input: input(), proceed: prepared });
    base.replayed();
    expect(base.traces).toEqual([
      expect.objectContaining({
        intent: 'search',
        tool_calls: [
          { name: 'search_products', args: { q: '合成甲' }, status: 'ok' },
          { name: 'search_products', args: { q: '合成乙' }, status: 'failed' },
        ],
      }),
    ]);
  },
);

it('[AC-B3-05j#5][BR-AI-14] 无既有意图才补 search，模型给过 refine 则在降级后保留', async () => {
  // 同一规则对比两种入口；第二种由意图端口不接管结构化输出而触发 models_failed。
  const unnamed = setup();
  const named = setup([{ parts: ['{"agent_intent":"refine"}'] }]);
  await unnamed.run({ prompt: { current: async () => null } });
  await named.run({ intents: { handle: async () => null } });
  expect(unnamed.degraded.mock.calls[0]![0].reason).toBe('route_no_model');
  expect(named.degraded.mock.calls[0]![0].reason).toBe('models_failed');
  expect(named.traces).toEqual([expect.objectContaining({ intent: 'refine', tool_calls: [] })]);
  expect(unnamed.traces).toEqual([expect.objectContaining({ intent: 'search', tool_calls: [] })]);
  named.replayed();
});

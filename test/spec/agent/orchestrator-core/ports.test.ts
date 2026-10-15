import { expect, it, vi } from 'vitest';
import {
  createRunLabels,
  emptyOrchestratorTools,
  failClosedInputCheck,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { RunLabelsDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ResolvedRoute } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { context, FLASH, input, PLUS, resolved } from './kit.ts';

it('[AC-B3-05b#38][BR-AI-06] 空工具端口无定义、无平台、拒绝任意调用且不返回降级商品', async () => {
  const tools = emptyOrchestratorTools();
  const ctx = {
    subject: input().caller,
    runId: input().runId,
    sessionId: input().sessionId,
    signal: context().ctx.signal,
    placeholders: {},
  };
  expect(tools.definitions(input().caller)).toEqual([]);
  expect(await tools.enabledSearchPlatforms('synthetic-app')).toEqual([]);
  expect(
    await tools.execute(
      { id: 'synthetic-call', name: 'search_products', args: { q: '合成杯子' } },
      ctx,
    ),
  ).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  expect(
    await tools.execute({ id: 'synthetic-call-2', name: 'synthetic_unknown', args: null }, ctx),
  ).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  expect(
    await tools.searchKeyword({ q: '合成杯子', platforms: [], sort: 'relevance' }, ctx),
  ).toEqual({ results: [], cards: [] });
});

it('[AC-B3-05b#39][BR-AI-06] 默认输入检查总是拒绝并带可退还的审核超时 ending', async () => {
  const check = failClosedInputCheck();
  const result = {
    kind: 'refuse',
    textKey: 'agent.refuse.safety_unavailable',
    finishReason: 'safety',
    ending: 'input_review_timeout',
  };
  expect(await check.check(input(), context().ctx.signal)).toEqual(result);
  expect(await check.check({ ...input(), text: '合成正常请求' }, context().ctx.signal)).toEqual(
    result,
  );
});

function labelDeps(
  route: ResolvedRoute,
  prompt: { version: string; system: string } | null,
): RunLabelsDeps {
  return {
    route: vi.fn(async () => route),
    prompt: { current: vi.fn(async () => prompt) },
    modelLabel: vi.fn(async () => '合成模型显示名'),
    aiLabel: vi.fn(async () => '合成 AI 标识'),
  };
}

it.each([
  {
    label: '无模型路由',
    route: { mode: 'no_model' as const, attempts: [], dropped: [] },
    prompt: { version: 'synthetic-prompt', system: '合成前缀' },
    version: 'none',
    model: null,
  },
  {
    label: '无可用条目',
    route: resolved(),
    prompt: { version: 'synthetic-prompt', system: '合成前缀' },
    version: 'none',
    model: null,
  },
  {
    label: '无模型且未配提示词',
    route: { mode: 'no_model' as const, attempts: [], dropped: [] },
    prompt: null,
    version: 'none',
    model: null,
  },
  {
    label: '有路由未配提示词',
    route: resolved('flash', 'plus'),
    prompt: null,
    version: 'none',
    model: FLASH,
  },
  {
    label: '有主备路由',
    route: resolved('flash', 'plus'),
    prompt: { version: 'synthetic-prompt', system: '合成前缀' },
    version: 'synthetic-prompt',
    model: FLASH,
  },
])(
  '[AC-B3-05b#40][BR-AI-14] createRunLabels $label 使用解析后首模型和提示词版本',
  async ({ route, prompt, version, model }) => {
    const deps = labelDeps(route, prompt);
    const labels = createRunLabels(deps);
    expect(await labels.current(input().caller)).toEqual({
      promptVersion: version,
      modelSnapshot: model,
    });
    expect(deps.route).toHaveBeenCalledWith('synthetic-app');
  },
);

it('[AC-B3-05b#41][BR-AI-14][BR-AI-06] 标签端口每次读取当前路由，modelLabel 和 aiLabel 原样透传', async () => {
  const deps = labelDeps(resolved('flash'), { version: 'synthetic-prompt', system: '合成前缀' });
  const route = vi
    .fn()
    .mockResolvedValueOnce(resolved('flash'))
    .mockResolvedValueOnce(resolved('plus'));
  const labels = createRunLabels({ ...deps, route });
  expect(await labels.current(input().caller)).toEqual({
    promptVersion: 'synthetic-prompt',
    modelSnapshot: FLASH,
  });
  expect(await labels.current(input().caller)).toEqual({
    promptVersion: 'synthetic-prompt',
    modelSnapshot: PLUS,
  });
  expect(await labels.modelLabel('synthetic-other-app', null)).toBe('合成模型显示名');
  expect(deps.modelLabel).toHaveBeenCalledWith('synthetic-other-app', null);
  expect(await labels.aiLabel('synthetic-other-app')).toBe('合成 AI 标识');
  expect(deps.aiLabel).toHaveBeenCalledWith('synthetic-other-app');
});

import { expect, it, vi } from 'vitest';
import { createRunLabels } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { FLASH, PLUS, input, notice, proceed, setup, toolCall } from './kit.ts';

it.each(['synthetic-app', 'synthetic-other-app'])(
  '[AC-B3-05b#46][BR-AI-06] 固定文案异步按当前应用读取：%s',
  async (appId) => {
    const r = setup();
    r.check.mockResolvedValue({
      kind: 'refuse',
      textKey: 'agent.refuse.unsafe',
      finishReason: 'safety',
    });
    const text = vi.fn<AgentRunBodyDeps['texts']['text']>(async (app, key) => `${app}:${key}`);
    const value = input();
    expect(
      await r.run(
        { texts: { ...r.deps.texts, text } },
        {
          ...value,
          caller: { ...value.caller, appId },
        },
      ),
    ).toEqual({ kind: 'done', finishReason: 'safety' });
    expect(text).toHaveBeenCalledExactlyOnceWith(appId, 'agent.refuse.unsafe');
    expect(r.text()).toBe(`${appId}:agent.refuse.unsafe`);
    expect(r.complete).not.toHaveBeenCalled();
  },
);

it.each([
  { platform: 'taobao', templatePlatform: 'taobao', rejected: false },
  {
    platform: 'https://example.invalid/private-query',
    templatePlatform: undefined,
    rejected: true,
  },
])(
  '[AC-B3-05b#47][BR-AI-06] 工具定义按 app 异步读取，情境透传，模板只接收平台枚举：$platform',
  async ({ platform, templatePlatform, rejected }) => {
    const args = { q: '合成私有查询', platform };
    const modelView = rejected ? { error: 'invalid_args' as const } : {};
    const r = setup(
      [
        { calls: [toolCall('synthetic-platform', args)], views: [modelView] },
        { parts: ['请看结果。'] },
      ],
      {
        outcomes: rejected
          ? [{ kind: 'rejected', modelView: { error: 'invalid_args' } }]
          : [{ kind: 'ok', modelView, cards: [notice()] }],
      },
    );
    const value = input();
    const entryContext = { product_key: 'tb:synthetic-entry', source: 'synthetic-product' };
    const toolDisplay = vi.fn<AgentRunBodyDeps['texts']['toolDisplay']>(
      async (_app, _tool, phase, p) => `合成模板:${p ?? 'generic'}:${phase}`,
    );
    expect(
      await r.run(
        { texts: { ...r.deps.texts, toolDisplay } },
        {
          ...value,
          caller: { ...value.caller, appId: 'synthetic-other-app' },
          context: entryContext,
        },
      ),
    ).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(r.deps.tools.definitions).toHaveBeenCalledExactlyOnceWith('synthetic-other-app', {
      ...value.caller,
      appId: 'synthetic-other-app',
    });
    expect(r.execute.mock.calls[0]?.[1].context).toEqual(entryContext);
    expect(r.execute.mock.calls[0]?.[0].args).toEqual(args);
    const lastPhase = rejected ? 'failed' : 'end';
    expect(toolDisplay.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['synthetic-other-app', 'search_products', 'start'],
      ['synthetic-other-app', 'search_products', lastPhase],
    ]);
    expect(toolDisplay.mock.calls.map((call) => call[3])).toEqual([
      templatePlatform,
      templatePlatform,
    ]);
    expect(r.events.filter((event) => event.kind === 'status')).toEqual([
      {
        kind: 'status',
        tool: 'search_products',
        phase: 'start',
        display: `合成模板:${templatePlatform ?? 'generic'}:start`,
      },
      {
        kind: 'status',
        tool: 'search_products',
        phase: lastPhase,
        display: `合成模板:${templatePlatform ?? 'generic'}:${lastPhase}`,
      },
    ]);
    expect(JSON.stringify(toolDisplay.mock.calls)).not.toContain('合成私有查询');
    expect(JSON.stringify(toolDisplay.mock.calls)).not.toContain('https://');
    r.replayed();
  },
);

it.each(['model', 'deterministic'] as const)(
  '[AC-B3-05b#48][BR-AI-06] 输入 notices 由核心在 %s 路径之前恰好下发一次',
  async (path) => {
    const notices = [notice('合成预处理提示一'), notice('合成预处理提示二')];
    const prepared = proceed({
      notices,
      links:
        path === 'deterministic'
          ? [{ kind: 'url', raw: 'https://example.invalid/item', index: 0 }]
          : [],
    });
    const r = setup(path === 'model' ? [{ parts: ['合成说明。'] }] : [], { proceed: prepared });
    const expectedNotices = notices.map((card) => ({ kind: 'card', card }));
    const run = vi.fn<NonNullable<AgentRunBodyDeps['deterministic']>['run']>(
      async (request, ctx) => {
        expect(request.proceed.notices).toEqual(notices);
        expect(r.content()).toEqual(expectedNotices);
        ctx.text('合成说明。');
        return { kind: 'done', finishReason: 'stop' };
      },
    );
    expect(await r.run({ deterministic: { run } })).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(r.content()).toEqual([...expectedNotices, { kind: 'text', text: '合成说明。' }]);
    expect(run).toHaveBeenCalledTimes(path === 'model' ? 0 : 1);
    expect(r.complete).toHaveBeenCalledTimes(path === 'model' ? 1 : 0);
    r.replayed();
  },
);

it('[AC-B3-05b#49][BR-AI-06][BR-AI-14] 输入 notices 共用卡片额度，到界不进入下游路径', async () => {
  const r = setup([], {
    proceed: proceed({
      notices: [notice('合成先发'), notice('不应再发')],
      links: [{ kind: 'url', raw: 'https://example.invalid/item', index: 0 }],
    }),
  });
  const run = vi.fn<NonNullable<AgentRunBodyDeps['deterministic']>['run']>(async () => ({
    kind: 'done',
    finishReason: 'stop',
  }));
  expect(
    await r.run({
      deterministic: { run },
      limits: { ...r.deps.limits, cards: 1 },
    }),
  ).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(r.content()).toEqual([{ kind: 'card', card: notice('合成先发') }]);
  expect(run).not.toHaveBeenCalled();
  expect(r.complete).not.toHaveBeenCalled();
});

it('[AC-B3-05b#50][BR-AI-14] 主模型超时后 trace 记真实备用模型及全部尝试，提示词与标签同源', async () => {
  const r = setup(
    [{ calls: [toolCall('synthetic-backup-tool')], views: [{}] }, { parts: ['合成备用答复。'] }],
    { primaryTimeout: true },
  );
  const labels = createRunLabels({
    route: async () => r.route(),
    prompt: r.deps.prompt,
    modelLabel: async () => '合成模型',
    aiLabel: async () => '合成标识',
  });
  expect(await labels.current(input().caller)).toEqual({
    promptVersion: 'synthetic-v1',
    modelSnapshot: FLASH,
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.traces.at(-1)).toMatchObject({
    model: PLUS,
    prompt_version: 'synthetic-v1',
    attempts: [
      { entryId: 'flash', result: 'timeout', elapsedMs: 0 },
      { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      { entryId: 'flash', result: 'timeout', elapsedMs: 0 },
      { entryId: 'plus', result: 'ok', elapsedMs: 0 },
    ],
  });
  // One read by labels and one by body, despite the two model rounds.
  expect(r.deps.prompt.current).toHaveBeenCalledTimes(2);
  expect(r.deps.prompt.current).toHaveBeenNthCalledWith(1, 'synthetic-app');
  expect(r.deps.prompt.current).toHaveBeenNthCalledWith(2, 'synthetic-app');
  expect(r.complete.mock.calls.map(([chat]) => chat.system)).toEqual([
    '合成系统前缀',
    '合成系统前缀',
  ]);
  expect(r.requests.map((request) => request.model)).toEqual([FLASH, PLUS, FLASH, PLUS]);
  expect(r.text()).toBe('合成备用答复。');
  r.replayed();
});

it('[AC-B3-05b#51][BR-AI-06] 未登记工具名不进入状态或模板，拒绝消息回传后继续循环', async () => {
  const unknownName = 'https://example.invalid/injected-tool';
  const r = setup([
    {
      calls: [toolCall('synthetic-unknown', { q: '合成查询' }, unknownName)],
      views: [{ error: 'invalid_args' }],
    },
    { parts: ['合成安全说明。'] },
  ]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.deps.texts.toolDisplay).not.toHaveBeenCalled();
  expect(r.events).toEqual([{ kind: 'text', text: '合成安全说明。' }]);
  expect(r.traces.at(-1)?.tool_calls).toEqual([
    { name: unknownName, args: { q: '合成查询' }, status: 'rejected' },
  ]);
  expect(r.complete).toHaveBeenCalledTimes(2);
  r.replayed();
});

it('[AC-B3-05b#52][BR-AI-14] 未配置提示词明确按 route_no_model 降级，不以空 system 调模型', async () => {
  const r = setup();
  const current = vi.fn(async () => null);
  const result = { kind: 'done', finishReason: 'budget' } as const;
  r.degraded.mockResolvedValue(result);
  expect(await r.run({ prompt: { current } })).toEqual(result);
  expect(current).toHaveBeenCalledExactlyOnceWith('synthetic-app');
  expect(r.degraded).toHaveBeenCalledTimes(1);
  expect(r.degraded.mock.calls[0]?.[0]).toEqual({
    reason: 'route_no_model',
    input: input(),
    proceed: proceed(),
  });
  expect(r.degraded.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.events).toEqual([]);
  expect(r.traces.at(-1)).toMatchObject({ model: null, prompt_version: 'none', attempts: [] });
});

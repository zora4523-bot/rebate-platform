import { expect, it, vi } from 'vitest';
import type {
  AgentRunBodyDeps,
  InputCheckResult,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { RunBodyResult } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { input, notice, proceed, setup, toolCall } from './kit.ts';

it.each([
  { kind: 'refuse', textKey: 'agent.refuse.unsafe', finishReason: 'safety' },
  {
    kind: 'refuse',
    textKey: 'agent.refuse.safety_unavailable',
    finishReason: 'safety',
    ending: 'input_review_timeout',
  },
] satisfies InputCheckResult[])(
  '[AC-B3-05b#11][BR-AI-06] 输入拒绝只输出固定文案并透传结局：$textKey',
  async (refusal) => {
    const r = setup();
    r.check.mockResolvedValue(refusal);
    expect(await r.run()).toEqual({
      kind: 'done',
      finishReason: refusal.finishReason,
      ...('ending' in refusal ? { ending: refusal.ending } : {}),
    });
    expect(r.events).toEqual([{ kind: 'text', text: `固定文案:${refusal.textKey}` }]);
    expect(r.check).toHaveBeenCalledWith(input(), r.ctx.signal);
    expect(r.complete).not.toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.degraded).not.toHaveBeenCalled();
  },
);

it.each([
  { label: '主备失败', options: { failAfter: 0 }, reason: 'models_failed', requests: 2 },
  { label: '累计模型等待用尽', options: { modelMs: 0 }, reason: 'model_timeout', requests: 0 },
  { label: '预算用尽', options: { budget: true }, reason: 'budget', requests: 0 },
])(
  '[AC-B3-05b#12][BR-AI-14] 未发内容时真路由器 $label 交给降级端口',
  async ({ options, reason, requests }) => {
    const r = setup([], options);
    const returned: RunBodyResult = {
      kind: 'error',
      error: {
        code: 50302,
        msg: '合成搜索失败',
        retryable: true,
        fallback: 'search',
        fallback_q: '合成词',
      },
    };
    r.degraded.mockResolvedValue(returned);
    expect(await r.run()).toEqual(returned);
    expect(r.degraded).toHaveBeenCalledTimes(1);
    expect(r.degraded.mock.calls[0]?.[0]).toEqual({ reason, input: input(), proceed: proceed() });
    expect(r.degraded.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
    expect(r.requests).toHaveLength(requests);
    expect(r.events).toEqual([]);
    expect(r.execute).not.toHaveBeenCalled();
  },
);

it('[AC-B3-05b#13][BR-AI-14] budget 降级返回的 done budget 原样保留', async () => {
  const r = setup([], { budget: true });
  r.degraded.mockImplementation(async (_request, ctx) => {
    await ctx.card(notice());
    return { kind: 'done', finishReason: 'budget' };
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'budget' });
  expect(r.events).toEqual([{ kind: 'card', card: notice() }]);
});

it.each(['text', 'card'] as const)(
  '[AC-B3-05b#14][BR-AI-14] 已有 %s 后模型失败按已有内容结束，不重复降级',
  async (delivered) => {
    const r = setup(
      [
        {
          ...(delivered === 'text' ? { parts: ['已发说明。'] } : {}),
          calls: [toolCall('synthetic-before-failure')],
          views: [{}],
        },
      ],
      {
        failAfter: 1,
        outcomes: [{ kind: 'ok', modelView: {}, cards: delivered === 'card' ? [notice()] : [] }],
      },
    );
    expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(r.degraded).not.toHaveBeenCalled();
    expect(r.content()).toHaveLength(1);
    expect(r.complete).toHaveBeenCalledTimes(2);
    expect(r.requests).toHaveLength(3);
    r.replayed();
  },
);

it('[AC-B3-05b#15][BR-AI-14] 只有 tool.status 不算已发文本或卡片，仍允许降级', async () => {
  const r = setup([{ calls: [toolCall('synthetic-empty')], views: [{}] }], { failAfter: 1 });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(r.degraded).toHaveBeenCalledTimes(1);
  expect(r.content()).toEqual([]);
  r.replayed();
});

it('[AC-B3-05b#16][BR-AI-14][BR-AI-06] 供应商拒答不切备用、不降级，固定话术以 safety 结束', async () => {
  const r = setup([{ parts: ['不应泄露的供应商文字'], finish: 'content_filter' }]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'safety' });
  expect(r.events).toEqual([{ kind: 'text', text: '固定文案:agent.refuse.unsafe' }]);
  expect(r.requests).toHaveLength(1);
  expect(r.degraded).not.toHaveBeenCalled();
  expect(r.execute).not.toHaveBeenCalled();
  r.replayed();
});

it('[AC-B3-05b#17][BR-AI-06] 未接意图端口时 JSON 意图不下发原文或卡片', async () => {
  const r = setup([{ parts: ['{"agent_intent":', '"page_guide","route":"wallet"}'] }]);
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.events).toEqual([{ kind: 'text', text: '固定文案:agent.refuse.out_of_scope' }]);
  expect(r.execute).not.toHaveBeenCalled();
  r.replayed();
});

it('[AC-B3-05b#18][BR-AI-06] 接入意图端口则交付完整文本与输入标记，以端口输出和结果为准', async () => {
  const text = '{"agent_intent":"page_guide","route":"wallet"}';
  const prepared = proceed({ untrustedInput: true, paramsRequested: true });
  const r = setup([{ parts: [text] }], { proceed: prepared });
  const handle = vi.fn<NonNullable<AgentRunBodyDeps['intents']>['handle']>(
    async (_request, ctx) => {
      ctx.text('合成意图端口固定话术');
      ctx.suggestions([{ text: '合成建议', send_text: '合成后续问题' }]);
      return { kind: 'done', finishReason: 'auth_required' };
    },
  );
  expect(await r.run({ intents: { handle } })).toEqual({
    kind: 'done',
    finishReason: 'auth_required',
  });
  expect(handle.mock.calls[0]?.[0]).toEqual({ text, input: input(), proceed: prepared });
  expect(handle.mock.calls[0]?.[1].signal).toBe(r.ctx.signal);
  expect(r.text()).toBe('合成意图端口固定话术');
  expect(r.content()).toHaveLength(2);
  r.replayed();
});

it('[AC-B3-05b#19][BR-AI-06] 意图端口返回 null 时普通说明继续经过 OutputGuard', async () => {
  const r = setup([{ parts: ['合成价格9元。'] }]);
  const handle = vi.fn<NonNullable<AgentRunBodyDeps['intents']>['handle']>(async () => null);
  expect(await r.run({ intents: { handle } })).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(handle).toHaveBeenCalledTimes(1);
  expect(r.text()).toBe('合成价格见卡片。');
  r.replayed();
});

it('[AC-B3-05b#20][BR-AI-14] 含链接且未接确定性端口，不调模型，出空结果 notice', async () => {
  const r = setup([], {
    proceed: proceed({
      links: [{ kind: 'url', raw: 'https://example.invalid/synthetic', index: 0 }],
    }),
  });
  expect(await r.run()).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(r.events).toEqual([
    {
      kind: 'card',
      card: {
        type: 'notice',
        schema_version: 1,
        data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
        fallback_text: '固定文案:agent.degraded.empty',
      },
    },
  ]);
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.degraded).not.toHaveBeenCalled();
  expect(r.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05b#21][BR-AI-14] 含链接交确定性端口，保留其结果且不进入模型', async () => {
  const prepared = proceed({
    links: [{ kind: 'tpwd', raw: '￥Abcd1234￥', index: 0 }],
    untrustedInput: true,
  });
  const r = setup([], { proceed: prepared });
  const run = vi.fn<NonNullable<AgentRunBodyDeps['deterministic']>['run']>(
    async (_request, ctx) => {
      await ctx.card(notice());
      return { kind: 'done', finishReason: 'stop' };
    },
  );
  expect(await r.run({ deterministic: { run } })).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(run.mock.calls[0]?.[0]).toEqual({ input: input(), proceed: prepared });
  expect(r.events).toEqual([{ kind: 'card', card: notice() }]);
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.degraded).not.toHaveBeenCalled();
});

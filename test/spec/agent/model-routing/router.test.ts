// createModelRouter 的失败分流：BR-AI-14 细则「路由顺序」「无模型降级」触发条件（主、备都失败；预算用完；切无模型）、
// 跨厂商兜底关闭（主备都失败直接降级，不换厂商）；BR-AI-16 预算用完走降级（摘录，只收布尔信号）；
// BR-AI-21 后台切换每次 complete 生效（摘录）；方案 §4.3.2 内容拒绝不换模型；鉴权 / 参数错误告警并降级（代理默认 K8）。
// 网络错误、协议错误（malformed）与 429 / 5xx / 超时同样切备用（口径见 tests-claude.md）。
import { expect, it } from 'vitest';
import type { ResolvedRoute } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { ModelErrorKind } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import {
  chatInput,
  ctx,
  entry,
  expectedEvents,
  fail,
  FLASH,
  FLASH_B,
  ok,
  PLUS,
  resolved,
  setup,
} from './kit.ts';

const switching: ModelErrorKind[] = ['timeout', 'rate_limited', 'server', 'network', 'malformed'];

it('[BR-AI-14 路由顺序] 主模型成功：返回 Flash 的结果与用量，备用从未被调用，attempts 只有一条 ok', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(120, 30)] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome).toEqual({
    kind: 'model',
    entryId: 'flash',
    model: FLASH,
    events: expectedEvents(FLASH, 120, 30),
    usage: { input_tokens: 120, output_tokens: 30 },
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
  });
  expect(rig.transport.callsFor(PLUS)).toBe(0);
  expect(rig.invokes).toEqual([
    { purpose: 'online', vendor: 'qwen', model: FLASH, dataClass: 'user_input' },
  ]);
});

it.each(switching)(
  '[BR-AI-14 无模型降级 触发] 主模型 %s：切到 Plus 备用，返回备用的结果与用量',
  async (kind) => {
    const rig = setup({ steps: { [FLASH]: [fail(kind)], [PLUS]: [ok(90, 12)] } });
    const outcome = await rig.router().complete(chatInput(), ctx());
    expect(outcome).toEqual({
      kind: 'model',
      entryId: 'plus',
      model: PLUS,
      events: expectedEvents(PLUS, 90, 12),
      usage: { input_tokens: 90, output_tokens: 12 },
      attempts: [
        { entryId: 'flash', result: kind, elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    });
    expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH, PLUS]);
  },
);

it.each(switching)(
  '[BR-AI-14 跨厂商兜底关闭] 主、备都 %s：degraded(models_failed)，传输恰好被调两次，全是千问',
  async (kind) => {
    const rig = setup({ steps: { [FLASH]: [fail(kind)], [PLUS]: [fail(kind)] } });
    const outcome = await rig.router().complete(chatInput(), ctx());
    expect(outcome).toEqual({
      kind: 'degraded',
      reason: 'models_failed',
      attempts: [
        { entryId: 'flash', result: kind, elapsedMs: 0 },
        { entryId: 'plus', result: kind, elapsedMs: 0 },
      ],
    });
    expect(rig.transport.calls).toHaveLength(2);
    expect(rig.invokes.every((c) => c.purpose === 'online' && c.vendor === 'qwen')).toBe(true);
  },
);

it('[BR-AI-14 跨厂商兜底关闭] 路由里已剔除的跨厂商条目不被启用：主备失败后不调用任何其他厂商或条目', async () => {
  const route: ResolvedRoute = {
    mode: 'models',
    attempts: [entry('flash'), entry('plus')],
    dropped: [{ id: 'glm-x', reason: 'cross_vendor_closed' }],
  };
  const rig = setup({
    route: () => route,
    steps: { [FLASH]: [fail('server')], [PLUS]: [fail('rate_limited')] },
  });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(rig.invokes.map((c) => [c.vendor, c.model])).toEqual([
    ['qwen', FLASH],
    ['qwen', PLUS],
  ]);
  expect(rig.transport.calls.map((c) => c.vendor)).toEqual(['qwen', 'qwen']);
});

it('[BR-AI-14 无模型降级 触发] 没有备用（backup 为 null）时主模型失败直接 degraded(models_failed)，传输只调一次', async () => {
  const rig = setup({ route: () => resolved('flash'), steps: { [FLASH]: [fail('server')] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome).toEqual({
    kind: 'degraded',
    reason: 'models_failed',
    attempts: [{ entryId: 'flash', result: 'server', elapsedMs: 0 }],
  });
  expect(rig.transport.calls).toHaveLength(1);
});

it('[方案 §4.3.2 内容拒绝不换模型] 主模型 content_refused：返回 refused，不调备用', async () => {
  const rig = setup({ steps: { [FLASH]: [fail('content_refused')], [PLUS]: [ok(1, 1)] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome).toEqual({
    kind: 'refused',
    entryId: 'flash',
    attempts: [{ entryId: 'flash', result: 'content_refused', elapsedMs: 0 }],
  });
  expect(rig.transport.callsFor(PLUS)).toBe(0);
  expect(rig.alerts).toEqual([]);
});

it.each(['auth', 'bad_request'] as const)(
  '[K8 代理默认] 主模型 %s：告警一次并 degraded(vendor_misconfigured)，不调备用',
  async (kind) => {
    const rig = setup({ steps: { [FLASH]: [fail(kind)], [PLUS]: [ok(1, 1)] } });
    const outcome = await rig.router().complete(chatInput(), ctx());
    expect(outcome).toEqual({
      kind: 'degraded',
      reason: 'vendor_misconfigured',
      attempts: [{ entryId: 'flash', result: kind, elapsedMs: 0 }],
    });
    expect(rig.alerts).toEqual([{ kind, entryId: 'flash' }]);
    expect(rig.transport.callsFor(PLUS)).toBe(0);
  },
);

it('[BR-AI-16 预算用完] budgetExhausted 为 true：degraded(budget)，不发生任何网关或传输调用', async () => {
  const rig = setup({ budgetExhausted: () => true, steps: { [FLASH]: [ok(1, 1)] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome).toEqual({ kind: 'degraded', reason: 'budget', attempts: [] });
  expect(rig.invokes).toEqual([]);
  expect(rig.transport.calls).toEqual([]);
});

it('[BR-AI-16 预算用完] 预算信号每次 complete 读一次：先未用完照常调用，之后用完即降级', async () => {
  let exhausted = false;
  const rig = setup({ budgetExhausted: () => exhausted, steps: { [FLASH]: [ok(5, 6), ok(5, 6)] } });
  const router = rig.router();
  expect((await router.complete(chatInput(), ctx())).kind).toBe('model');
  exhausted = true;
  expect(await router.complete(chatInput(), ctx())).toEqual({
    kind: 'degraded',
    reason: 'budget',
    attempts: [],
  });
  expect(rig.transport.calls).toHaveLength(1);
});

it('[BR-AI-21 切无模型] 路由为 no_model：degraded(route_no_model)，不调用传输', async () => {
  const rig = setup({ route: () => ({ mode: 'no_model', attempts: [], dropped: [] }) });
  expect(await rig.router().complete(chatInput(), ctx())).toEqual({
    kind: 'degraded',
    reason: 'route_no_model',
    attempts: [],
  });
  expect(rig.transport.calls).toEqual([]);
});

it('[BR-AI-21] 所有条目都被剔除：degraded(route_unavailable)，不调用传输', async () => {
  const route: ResolvedRoute = {
    mode: 'models',
    attempts: [],
    dropped: [
      { id: 'flash', reason: 'not_evaluated' },
      { id: 'plus', reason: 'not_evaluated' },
    ],
  };
  const rig = setup({ route: () => route });
  expect(await rig.router().complete(chatInput(), ctx())).toEqual({
    kind: 'degraded',
    reason: 'route_unavailable',
    attempts: [],
  });
  expect(rig.transport.calls).toEqual([]);
});

it('[BR-AI-21 后台切换] route() 每次 complete 读一次：切到无模型后下一次即降级，切到另一个已评测的 Flash 快照后用新快照', async () => {
  let current: ResolvedRoute = resolved('flash', 'plus');
  const rig = setup({
    route: () => current,
    steps: { [FLASH]: [ok(3, 4)], [FLASH_B]: [ok(3, 4)] },
  });
  const router = rig.router();
  expect((await router.complete(chatInput(), ctx())).kind).toBe('model');
  current = { mode: 'no_model', attempts: [], dropped: [] };
  const second = await router.complete(chatInput(), ctx());
  expect(second.kind === 'degraded' && second.reason).toBe('route_no_model');
  current = {
    mode: 'models',
    attempts: [entry('flash-b', { model: FLASH_B }), entry('plus')],
    dropped: [],
  };
  const third = await router.complete(chatInput(), ctx());
  expect(third.kind === 'model' && third.entryId).toBe('flash-b');
  expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH, FLASH_B]);
});

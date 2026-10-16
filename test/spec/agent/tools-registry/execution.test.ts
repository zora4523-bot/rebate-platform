import { expect, it } from 'vitest';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { call, handler, rejected, setup, subject, toolContext } from './kit.ts';

it.each([
  null,
  [],
  true,
  7,
  '{broken-json',
  '{"q":"合成牛奶"}',
  {},
  { q: 7 },
  { q: '' },
  { q: '合成牛奶', platform: 'synthetic-unknown' },
  { q: '合成牛奶', color: 'red' },
  { q: '合成牛奶', filters: { label: '合成', color: 'red' } },
  { q: '合成牛奶', choices: [{ label: '合成', color: 'red' }] },
])('[AC-B3-04a#7][BR-AI-03] 非法参数拒绝而不修补执行，普通 schema 错误不告警 %#', async (args) => {
  const target = handler();
  const { registry, warn } = setup([target]);
  const original = structuredClone(args);
  expect(await registry.execute(call(args), toolContext())).toEqual(rejected);
  expect(target.run).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(args).toEqual(original);
});

// BR-AI-03 初始清单全覆盖，变体的期望值不依赖被测 normalizeIdentityKey。
const identityKeys = [
  'user_id',
  'uid',
  'app_id',
  'device_id',
  'scene',
  'pid',
  'p_id',
  'adzone_id',
  'site_id',
  'position_id',
  'relation_id',
  'special_id',
  'sub_union_id',
  'custom_parameters',
  'union_id',
  'adzoneId',
  'sub_unionid',
  'pId',
  'positionId',
  'USER-ID',
  'AppId',
  'deviceId',
  'subUnionId',
  'customParameters',
  'ReLaTiOn-Id',
];

it.each(identityKeys)(
  '[AC-B3-04a#8][BR-AI-03] 身份键 %s 在顶层、嵌套对象或数组中均拒绝且每次只告警一次',
  async (key) => {
    const target = handler();
    const { registry, warn } = setup([target]);
    const payloads = [
      { q: '合成牛奶', [key]: 'synthetic-attacker' },
      { q: '合成牛奶', filters: { [key]: 'synthetic-attacker' } },
      { q: '合成牛奶', choices: [{ label: '合成' }, { [key]: 'synthetic-attacker' }] },
    ];
    for (const args of payloads) {
      warn.mockClear();
      const original = structuredClone(args);
      expect(await registry.execute(call(args), toolContext())).toEqual(rejected);
      expect(target.run).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).toContain('agent.identity_arg');
      expect(args).toEqual(original);
    }
  },
);

it('[AC-B3-04a#9][BR-AI-03] 一次调用命中多个身份字段只告警一次，不丢弃后继续执行', async () => {
  const target = handler();
  const { registry, warn } = setup([target]);
  const args = {
    q: '合成牛奶',
    user_id: 'synthetic-other-user',
    filters: { pId: 'synthetic-slot' },
    scene: 'synthetic-scene',
  };
  const original = structuredClone(args);
  expect(await registry.execute(call(args), toolContext())).toEqual(rejected);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls[0])).toContain('agent.identity_arg');
  expect(target.run).not.toHaveBeenCalled();
  expect(args).toEqual(original);
});

it.each([
  'synthetic_unknown',
  'page_guide',
  'clarify',
  'parse_input',
  'resolve_link',
  'register_links',
  'toString',
  '__proto__',
])('[AC-B3-04a#10][BR-AI-02] 未注册名称 %s 一律拒绝，包括对象原型名称', async (name) => {
  const target = handler();
  const { registry } = setup([target]);
  expect(await registry.execute(call({ q: '合成牛奶' }, name), toolContext())).toEqual(rejected);
  expect(target.run).not.toHaveBeenCalled();
});

it('[AC-B3-04a#11][BR-AI-02][BR-AI-11] 下发给已绑手机用户的工具不能被其他主体直接调用', async () => {
  const handlers = ['list_my_orders', 'explain_order', 'prefill_claim', 'get_my_earnings'].map(
    (name) => handler(name, 'phone_bound'),
  );
  const { registry } = setup(handlers);
  expect(await registry.definitions('synthetic-app', subject())).toHaveLength(4);
  for (const caller of [subject(null, false), subject('synthetic-unbound', false)]) {
    for (const target of handlers) {
      expect(
        await registry.execute(call({ q: '合成' }, target.name), toolContext({ subject: caller })),
      ).toEqual(rejected);
      expect(target.run).not.toHaveBeenCalled();
    }
  }
  for (const target of handlers) {
    expect((await registry.execute(call({ q: '合成' }, target.name), toolContext())).kind).toBe(
      'ok',
    );
    expect(target.run).toHaveBeenCalledTimes(1);
  }
});

it('[AC-B3-04a#12][BR-AI-02] 已注册但当前应用关闭的工具拒绝执行', async () => {
  const target = handler();
  const { registry, get } = setup([target]);
  get.mockImplementation(async (app) => app === 'synthetic-app');
  expect(await registry.definitions('synthetic-app', subject())).toHaveLength(1);
  const other = { ...subject(), appId: 'synthetic-other-app' };
  expect(await registry.definitions(other.appId, other)).toEqual([]);
  expect(await registry.execute(call(), toolContext({ subject: other }))).toEqual(rejected);
  expect(target.run).not.toHaveBeenCalled();
});

it('[AC-B3-04a#13][BR-AI-03] 合法参数原样到 handler，身份只取当前调用的服务端 caller', async () => {
  const target = handler();
  const { registry, warn } = setup([target]);
  const callers = [
    subject(),
    subject(null, false),
    {
      ...subject('synthetic-other-user'),
      appId: 'synthetic-other-app',
      deviceId: 'synthetic-other-device',
    },
  ];
  for (const caller of callers) {
    const args = {
      q: '合成 user_id 字样只是文本',
      filters: { label: '合成规格' },
      choices: [{ label: '合成颜色' }],
    };
    const original = structuredClone(args);
    const ctx = toolContext({
      subject: caller,
      context: { scene: 'synthetic-untrusted-scene', user_id: 'synthetic-forged-user' },
    });
    expect(await registry.execute(call(args), ctx)).toEqual({
      kind: 'ok',
      modelView: { card_id: 'synthetic-card' },
      cards: [],
    });
    expect(target.run).toHaveBeenLastCalledWith(
      args,
      expect.objectContaining({
        appId: caller.appId,
        userId: caller.userId,
        deviceId: caller.deviceId,
        phoneBound: caller.phoneBound,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      }),
    );
    const injected = target.run.mock.calls.at(-1)?.[1];
    expect(injected).not.toHaveProperty('scene', 'synthetic-untrusted-scene');
    expect(args).toEqual(original);
  }
  expect(target.run).toHaveBeenCalledTimes(3);
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B3-04a#14][BR-AI-03] 模型伪造上下文键不能覆盖服务端身份或调用元数据', async () => {
  const target = handler();
  const { registry } = setup([target]);
  for (const key of [
    'appId',
    'userId',
    'deviceId',
    'phoneBound',
    'runId',
    'sessionId',
    'signal',
    'toolCtx',
    'subject',
  ]) {
    expect(
      await registry.execute(call({ q: '合成牛奶', [key]: 'synthetic-forged' }), toolContext()),
    ).toEqual(rejected);
  }
  expect(target.run).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'] as const)(
  '[AC-B3-04a#15][BR-AI-02] handler %s 转为 failed，错误原文与堆栈不传模型',
  async (mode) => {
    const target = handler();
    const { registry } = setup([target]);
    const error = new Error('synthetic-private-handler-error');
    error.stack = 'synthetic-private-stack';
    target.run.mockImplementation(() => {
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    const outcome = await registry.execute(call(), toolContext());
    expect(outcome.kind).toBe('failed');
    expect(outcome.modelView).toBeDefined();
    expect(JSON.stringify(outcome.modelView)).not.toContain(error.message);
    expect(JSON.stringify(outcome.modelView)).not.toContain(error.stack);
    expect(target.run).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-04a#16][BR-AI-02] 超时由调用方 signal 传入，handler 收到中止而不固定等待', async () => {
  const target = handler();
  const { registry } = setup([target]);
  const controller = new AbortController();
  const started = Promise.withResolvers<ToolCallContext>();
  let observedAbort = false;
  target.run.mockImplementation(
    (_args, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(ctx.signal.reason);
          },
          { once: true },
        );
        started.resolve(ctx);
      }),
  );
  const pending = registry.execute(call(), toolContext({ signal: controller.signal }));
  const injected = await started.promise;
  expect(injected.signal).toBe(controller.signal);
  controller.abort(new Error('synthetic-timeout-reason'));
  const outcome = await pending;
  expect(observedAbort).toBe(true);
  expect(outcome.kind).toBe('failed');
  expect(JSON.stringify(outcome.modelView)).not.toContain('synthetic-timeout-reason');
  expect(target.run).toHaveBeenCalledTimes(1);
});

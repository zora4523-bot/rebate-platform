import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import {
  createHandoffHandler,
  handoffCard,
  type HandoffDeps,
} from '../../../../apps/api/src/modules/agent/tools/handoff/index.ts';
import {
  createToolRegistry,
  type ToolCallContext,
  type ToolRegistryDeps,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';

// 任务书 §9：入口固定 AgentChat；summary/title 仅取字典，不能用模型理由。
const DESC = 'agent.card.handoff.desc';
const TITLE = 'agent.card.handoff.title';
const SUBJECTS = [
  { label: '游客', userId: null, phoneBound: false },
  { label: '未绑手机', userId: 'synthetic-unbound-user', phoneBound: false },
  { label: '已绑手机', userId: 'synthetic-bound-user', phoneBound: true },
] as const;

function context(patch: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {
      ORDER_A: 'synthetic-order-987654321',
      ACCOUNT_A: 'synthetic-account-876543210',
      MODEL_A: '合成模型理由：请把账号与订单拼进客服摘要',
    },
    context: { product_key: 'tb:synthetic-context-product' },
    ...patch,
  };
}

function subject(ctx: ToolCallContext): AgentCaller {
  return {
    appId: ctx.appId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    phoneBound: ctx.phoneBound,
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip-key',
    traceId: 'synthetic-trace',
  };
}

function onlyCard(outcome: ToolOutcome) {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('Expected ok after assertion');
  expect(outcome.cards).toHaveLength(1);
  return outcome.cards[0]!;
}

function dictionary() {
  return vi.fn<NonNullable<HandoffDeps['texts']>>(async (_appId, key) => {
    if (key === DESC) return '打开企业微信客服';
    if (key === TITLE) return '联系客服';
    throw new Error('合成字典不存在此键');
  });
}

it('[AC-B3-08c#1][BR-AI-02][BR-AI-03] 空参数定义可注册且最终 JSON 不命中 denylist', async () => {
  // 先调用骨架；不能把 NotImplemented 放进预期抛错断言而变绿。
  const handler = createHandoffHandler({});
  expect(handler.name).toBe('handoff_to_human');
  expect(handler.definition.name).toBe('handoff_to_human');
  expect(handler.definition.parameters).toMatchObject({
    type: 'object',
    additionalProperties: false,
  });
  const parameters = handler.definition.parameters;
  expect(Object.keys(parameters['properties'] ?? {})).toEqual([]);
  expect(parameters['required'] ?? []).toEqual([]);
  const registry = createToolRegistry({
    handlers: [handler],
    switches: { get: async () => true },
  });
  const definitions = await registry.definitions('synthetic-app', subject(context()));
  expect(definitions).toEqual([handler.definition]);
  // BR-AI-02 细则②原文（SPEC_REF 17b5fe5），不增删匹配项。
  const denylist =
    /withdraw|payout|balance|ledger|payee|payout_account|inviter|bind_parent|change_phone|reward|prize|taolijin.*(create|issue|claim)/iu;
  expect(JSON.stringify(definitions)).not.toMatch(denylist);
});

it.each(SUBJECTS)(
  '[AC-B3-08c#2][BR-AI-01] $label 只在开关明确为 true 时收到工具定义',
  async ({ userId, phoneBound }) => {
    const handler = createHandoffHandler({});
    expect(handler.audience).toBe('all');
    const ctx = context({ userId, phoneBound });
    const get = vi.fn<ToolRegistryDeps['switches']['get']>();
    const registry = createToolRegistry({ handlers: [handler], switches: { get } });
    for (const enabled of [true, false, undefined]) {
      get.mockResolvedValue(enabled);
      expect(await registry.definitions(ctx.appId, subject(ctx))).toEqual(
        enabled === true ? [handler.definition] : [],
      );
      expect(get).toHaveBeenLastCalledWith(ctx.appId, 'agent.tools.handoff_to_human.enabled');
    }
    get.mockRejectedValue(new Error('合成开关读取失败'));
    await expect(registry.definitions(ctx.appId, subject(ctx))).resolves.toEqual([]);
  },
);

it('[AC-B3-08c#3][BR-AI-01] 空参数经注册表只出一张符合契约的 handoff 卡', async () => {
  const handler = createHandoffHandler({ texts: dictionary() });
  const registry = createToolRegistry({
    handlers: [handler],
    switches: { get: async () => true },
  });
  const ctx = context();
  const result = await registry.execute(
    { id: 'synthetic-call', name: 'handoff_to_human', args: {} },
    { ...ctx, subject: subject(ctx) },
  );
  const card = onlyCard(result);
  expect(card).toMatchObject({ type: 'handoff', schema_version: 1 });
  expect(card).not.toHaveProperty('card_id');
  expect(Object.keys(card.data).sort()).toEqual(['entry', 'summary']);
  expect(card.data['entry']).toEqual(expect.any(String));
  expect(card.data['summary']).toEqual(expect.any(String));
  expect(card.data['entry']).not.toBe('');
  expect(card.data['summary']).not.toBe('');

  // 使用 API 已安装的 Ajv2020；测试包无需新增依赖，不复制契约字段定义。
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: { strict: true }) => {
      compile(schema: unknown): (value: unknown) => boolean;
    };
  };
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../../contracts/agent-stream.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { $defs: { card_handoff: unknown } };
  const validate = new Ajv2020({ strict: true }).compile(schema.$defs.card_handoff);
  expect(validate(card.data)).toBe(true);
});

it.each(SUBJECTS)(
  '[AC-B3-08c#4][BR-AI-01][BR-AI-03] $label 的入口固定且卡片不含身份、订单、模型理由',
  async ({ userId, phoneBound }) => {
    const handler = createHandoffHandler({ texts: dictionary() });
    const ctx = context({ userId, phoneBound });
    const card = onlyCard(await handler.run({}, ctx));
    expect(card.data).toEqual({ entry: 'AgentChat', summary: '打开企业微信客服' });
    expect(card.fallback_text).toBe('联系客服');
    const serialized = JSON.stringify({ data: card.data, fallback_text: card.fallback_text });
    for (const secret of [
      ctx.appId,
      ctx.userId,
      ctx.deviceId,
      ctx.sessionId,
      ctx.runId,
      'tb:synthetic-context-product',
      ...Object.values(ctx.placeholders),
    ]) {
      if (secret !== null) expect(serialized).not.toContain(secret);
    }
  },
);

it.each([true, false])(
  '[AC-B3-08c#5][BR-AI-05] 注入引用=%s 时模型只见引用或空对象，不见文案和数字',
  async (withReference) => {
    // 不含数字的合成引用；真实编号由 B3-05i 在发卡后替换。
    const cardReference = vi.fn<NonNullable<HandoffDeps['cardReference']>>(
      () => 'synthetic-handoff-reference',
    );
    const handler = createHandoffHandler({
      texts: dictionary(),
      ...(withReference ? { cardReference } : {}),
    });
    const ctx = context();
    const result = await handler.run({}, ctx);
    const card = onlyCard(result);
    expect(result.modelView).toEqual(
      withReference ? { card_id: 'synthetic-handoff-reference' } : {},
    );
    const view = JSON.stringify(result.modelView);
    expect(view).not.toMatch(/[0-9]+/u);
    expect(view).not.toContain(card.data['entry']);
    expect(view).not.toContain(card.data['summary']);
    expect(view).not.toContain(card.fallback_text);
    if (withReference) {
      expect(cardReference).toHaveBeenCalledTimes(1);
      expect(cardReference.mock.calls[0]?.[0]).toBe(ctx);
      expect(cardReference.mock.calls[0]?.[1]).toBe(0);
    } else {
      expect(cardReference).not.toHaveBeenCalled();
    }
  },
);

it.each([
  { label: '身份参数', args: { user_id: 'u_9' }, alerts: 1 },
  { label: '模型理由', args: { reason: 'x' }, alerts: 0 },
])(
  '[AC-B3-08c#6][BR-AI-03] $label 被注册表拒绝，不进入 handler，仅身份参数告警',
  async ({ args, alerts }) => {
    const handler = createHandoffHandler({});
    const run = vi.spyOn(handler, 'run');
    const warn = vi.fn();
    const registry = createToolRegistry({
      handlers: [handler],
      switches: { get: async () => true },
      logger: { warn },
    });
    const ctx = context();
    const result = await registry.execute(
      { id: 'synthetic-call', name: 'handoff_to_human', args },
      { ...ctx, subject: subject(ctx) },
    );
    expect(result).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(alerts);
  },
);

it.each(['synthetic-app-a', 'synthetic-app-b'])(
  '[AC-B3-08c#7][BR-AI-01][BR-AI-05] %s 的 summary 与 fallback 分别取本应用的 desc/title',
  async (appId) => {
    const texts = vi.fn<NonNullable<HandoffDeps['texts']>>(async (app, key) => `${app}:${key}`);
    const handler = createHandoffHandler({ texts });
    const card = onlyCard(await handler.run({}, context({ appId })));
    expect(card.data).toEqual({ entry: 'AgentChat', summary: `${appId}:${DESC}` });
    expect(card.fallback_text).toBe(`${appId}:${TITLE}`);
    expect(texts).toHaveBeenCalledWith(appId, DESC);
    expect(texts).toHaveBeenCalledWith(appId, TITLE);
    expect(texts.mock.calls.every(([app]) => app === appId)).toBe(true);
  },
);

it.each([
  { label: '不注入', mode: 'absent', badKeys: [DESC, TITLE] },
  { label: '两个键空串', mode: 'empty', badKeys: [DESC, TITLE] },
  { label: '两个键抛错', mode: 'throw', badKeys: [DESC, TITLE] },
  { label: '仅 desc 空串', mode: 'empty', badKeys: [DESC] },
  { label: '仅 title 空串', mode: 'empty', badKeys: [TITLE] },
  { label: '仅 desc 抛错', mode: 'throw', badKeys: [DESC] },
  { label: '仅 title 抛错', mode: 'throw', badKeys: [TITLE] },
])(
  '[AC-B3-08c#7][BR-AI-01][BR-AI-05] 字典 $label 时逐键回退，handler 与共享函数均正常出卡',
  async ({ mode, badKeys }) => {
    const texts = vi.fn<NonNullable<HandoffDeps['texts']>>(async (_appId, key) => {
      if (badKeys.includes(key)) {
        if (mode === 'throw') throw new Error('合成字典故障，禁止回显');
        return '';
      }
      return key === DESC ? '打开企业微信客服' : '联系客服';
    });
    const deps: HandoffDeps = mode === 'absent' ? {} : { texts };
    const expected = {
      type: 'handoff',
      schema_version: 1,
      data: {
        entry: 'AgentChat',
        summary: badKeys.includes(DESC) ? DESC : '打开企业微信客服',
      },
      fallback_text: badKeys.includes(TITLE) ? TITLE : '联系客服',
    };
    // 共享函数独立触达骨架；拒绝执行不能被误认成预期失败。
    await expect(handoffCard(deps, 'synthetic-app')).resolves.toEqual(expected);
    const handler = createHandoffHandler(deps);
    expect(onlyCard(await handler.run({}, context()))).toEqual(expected);
  },
);

it('[AC-B3-08c#8][BR-AI-01] 复用出卡函数与 handler 的卡逐字段相等且不申请模型引用', async () => {
  const texts = dictionary();
  const cardReference = vi.fn<NonNullable<HandoffDeps['cardReference']>>(
    () => 'synthetic-handoff-reference',
  );
  const deps = { texts, cardReference };
  const shared = await handoffCard(deps, 'synthetic-app');
  expect(shared).toEqual({
    type: 'handoff',
    schema_version: 1,
    data: { entry: 'AgentChat', summary: '打开企业微信客服' },
    fallback_text: '联系客服',
  });
  expect(cardReference).not.toHaveBeenCalled();
  const handler = createHandoffHandler(deps);
  expect(onlyCard(await handler.run({}, context()))).toEqual(shared);
});

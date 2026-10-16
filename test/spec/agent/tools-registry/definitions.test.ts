import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  createToolRegistry,
  registeredToolNames,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { normalizeIdentityKey } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { call, definition, handler, rejected, setup, subject, toolContext } from './kit.ts';

it('[AC-B3-04a#1][BR-AI-02][BR-AI-11] 下发集合取已注册、开关开启与主体允许的交集', async () => {
  const handlers = [
    handler(),
    handler('get_rebate_quote'),
    ...['list_my_orders', 'explain_order', 'prefill_claim', 'get_my_earnings'].map((name) =>
      handler(name, 'phone_bound'),
    ),
  ];
  const { registry, get } = setup(handlers);
  get.mockImplementation(async (_app, key) => key !== 'agent.tools.get_rebate_quote.enabled');
  for (const caller of [subject(null, false), subject('synthetic-unbound', false)]) {
    expect((await registry.definitions(caller.appId, caller)).map((d) => d.name)).toEqual([
      'search_products',
    ]);
  }
  expect(
    (await registry.definitions('synthetic-app', subject())).map((d) => d.name).sort(),
  ).toEqual(
    [
      'search_products',
      'list_my_orders',
      'explain_order',
      'prefill_claim',
      'get_my_earnings',
    ].sort(),
  );
  for (const item of handlers) {
    expect(get).toHaveBeenCalledWith('synthetic-app', `agent.tools.${item.name}.enabled`);
  }
  expect(handlers.every((item) => item.run.mock.calls.length === 0)).toBe(true);
});

it.each(['reject', 'throw', 'missing'] as const)(
  '[AC-B3-04a#2][BR-AI-02] 开关读取 %s 时仅关闭对应工具，不向模型抛错',
  async (mode) => {
    const search = handler();
    const quote = handler('get_rebate_quote');
    const { registry, get } = setup([search, quote]);
    get.mockImplementation((_app, key) => {
      if (key === 'agent.tools.get_rebate_quote.enabled') return Promise.resolve(true);
      if (mode === 'throw') throw new Error('synthetic-settings-unavailable');
      if (mode === 'reject') return Promise.reject(new Error('synthetic-settings-unavailable'));
      return Promise.resolve(undefined);
    });
    expect((await registry.definitions('synthetic-app', subject())).map((d) => d.name)).toEqual([
      'get_rebate_quote',
    ]);
    expect(await registry.execute(call(), toolContext())).toEqual(rejected);
    expect(search.run).not.toHaveBeenCalled();
  },
);

it('[AC-B3-04a#3][BR-AI-02] 不同 app 的工具开关互不串用，全部关闭时定义为空', async () => {
  const { registry, get } = setup();
  get.mockImplementation(async (app) => app === 'synthetic-app-a');
  const a = { ...subject(), appId: 'synthetic-app-a' };
  const b = { ...subject(), appId: 'synthetic-app-b' };
  expect((await registry.definitions(a.appId, a)).map((d) => d.name)).toEqual(['search_products']);
  expect(await registry.definitions(b.appId, b)).toEqual([]);
  expect((await registry.definitions(a.appId, a)).map((d) => d.name)).toEqual(['search_products']);
});

it('[AC-B3-04a#4][BR-AI-02] 注册名和本段 allowlist 精确相等，禁止工具与意图不混入', async () => {
  // 台账明确本段仅商品搜索/报价；以后由各 handler 任务同步扩展。
  const handlers = [handler(), handler('get_rebate_quote')];
  const names = registeredToolNames(handlers); // 必须先调用骨架，再读文件。
  const raw = readFileSync(
    new URL('../../../../specs/agent-tools.allowlist', import.meta.url),
    'utf8',
  );
  const allowlist = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  expect([...names].sort()).toEqual(['get_rebate_quote', 'search_products']);
  expect([...allowlist].sort()).toEqual([...names].sort());
  expect(new Set(names).size).toBe(names.length);
  expect(new Set(allowlist).size).toBe(allowlist.length);
  // BR-AI-02 细则②原文。门禁脚本与依赖规则不在本任务范围。
  const denylist =
    /withdraw|payout|balance|ledger|payee|payout_account|inviter|bind_parent|change_phone|reward|prize|taolijin.*(create|issue|claim)/iu;
  expect(raw).not.toMatch(denylist);
  expect(names.join('\n')).not.toMatch(denylist);
  const { registry } = setup(handlers);
  const definitions = await registry.definitions('synthetic-app', subject());
  expect(definitions.map((d) => d.name).sort()).toEqual([...names].sort());
  expect(JSON.stringify(definitions)).not.toMatch(denylist);
  for (const forbidden of [
    'parse_input',
    'resolve_link',
    'register_links',
    'clarify',
    'page_guide',
  ]) {
    expect(names).not.toContain(forbidden);
  }
});

it('[AC-B3-04a#5][BR-AI-03] 完整下发 schema 闭合且任意层级没有清单身份属性', async () => {
  const { registry } = setup([handler(), handler('get_rebate_quote')]);
  const definitions = await registry.definitions('synthetic-app', subject());
  const fields = readFileSync(
    new URL('../../../../specs/agent-identity-fields.txt', import.meta.url),
    'utf8',
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const forbidden = new Set(fields.map(normalizeIdentityKey));
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node['type'] === 'object' || node['properties'] !== undefined) {
      expect(node['additionalProperties']).toBe(false);
    }
    const properties = node['properties'];
    if (properties !== null && typeof properties === 'object') {
      for (const key of Object.keys(properties))
        expect(forbidden.has(normalizeIdentityKey(key))).toBe(false);
    }
    Object.values(node).forEach(visit);
  };
  expect(definitions).toHaveLength(2);
  for (const item of definitions) {
    expect(item.parameters).toEqual(definition(item.name).parameters);
    visit(item.parameters);
  }
});

it('[AC-B3-04a#20][BR-AI-02] 注册名来自实际注入的 handler 集合，空注册表不虚报工具', () => {
  const names = registeredToolNames([handler('get_rebate_quote')]);
  expect(names).toEqual(['get_rebate_quote']);
  expect(registeredToolNames([])).toEqual([]);
  expect(
    registeredToolNames([handler('search_rules'), handler('handoff_to_human')])
      .slice()
      .sort(),
  ).toEqual(['handoff_to_human', 'search_rules']);
});

it.each([
  { type: 'object', properties: {} },
  { type: 'object', additionalProperties: true, properties: {} },
  {
    type: 'object',
    additionalProperties: false,
    properties: { filters: { type: 'object', properties: { label: { type: 'string' } } } },
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { filters: { $ref: '#/$defs/filter' } },
    $defs: {
      filter: {
        type: 'object',
        additionalProperties: false,
        properties: { 'APP-ID': { type: 'string' } },
      },
    },
  },
  { type: 'object', additionalProperties: false, properties: { adzoneId: { type: 'string' } } },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: { pId: { type: 'string' } },
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      choices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { sub_unionid: { type: 'string' } },
        },
      },
    },
  },
])('[AC-B3-04a#6][BR-AI-03] 不安全的 handler schema 不得注册下发 %#', async (parameters) => {
  const { registry, deps } = setup();
  expect(await registry.definitions('synthetic-app', subject())).toHaveLength(1);
  const unsafe = { ...handler(), definition: { ...definition(), parameters } };
  // 配置错误在注册时显式拒绝；不自动删属性、修改 handler 的业务契约。
  expect(() => createToolRegistry({ ...deps, handlers: [unsafe] })).toThrow();
});

import { expect, it, vi } from 'vitest';
import type { ToolRegistryDeps } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { caller, context, EXPLAIN, LIST, rejected, setup } from './kit.ts';

const DATES = { date_from: '2026-10-01', date_to: '2026-10-23' };

function schemaOf(definition: { readonly parameters: unknown }): Record<string, unknown> {
  return definition.parameters as Record<string, unknown>;
}

it('[AC-B3-08a#1][BR-AI-03][BR-AI-07] 两个 definition 封闭、无身份字段，字段名与契约一致', async () => {
  const f = setup();
  expect(f.list.name).toBe(LIST);
  expect(f.list.definition.name).toBe(LIST);
  expect(f.explain.name).toBe(EXPLAIN);
  expect(f.explain.definition.name).toBe(EXPLAIN);
  const ctx = context();
  const definitions = await f.registry.definitions(ctx.appId, caller(ctx));
  expect(definitions.map((definition) => definition.name).sort()).toEqual([EXPLAIN, LIST]);

  const list = schemaOf(f.list.definition);
  expect(list).toMatchObject({ type: 'object', additionalProperties: false });
  expect(Object.keys(list['properties'] as object).sort()).toEqual([
    'date_from',
    'date_to',
    'keyword',
    'limit',
    'platform',
  ]);
  expect([...(list['required'] as string[])].sort()).toEqual(['date_from', 'date_to']);

  const explain = schemaOf(f.explain.definition);
  expect(explain).toMatchObject({ type: 'object', additionalProperties: false });
  expect(Object.keys(explain['properties'] as object).sort()).toEqual([
    'card_id',
    'order_no',
    'platform',
  ]);
  const serialized = JSON.stringify(definitions);
  for (const identity of ['user_id', 'app_id', 'userId', 'appId', 'order_id']) {
    expect(serialized).not.toContain(`"${identity}"`);
  }
});

it.each([
  { label: '缺 date_to', args: { date_from: '2026-10-01' } },
  { label: '缺 date_from', args: { date_to: '2026-10-23' } },
  { label: '日期少一位', args: { date_from: '2026-10-1', date_to: '2026-10-23' } },
  { label: '斜杠日期', args: { date_from: '2026/10/01', date_to: '2026-10-23' } },
  { label: '无分隔日期', args: { date_from: '20261001', date_to: '2026-10-23' } },
  { label: '日期带时间', args: { date_from: '2026-10-01T00:00:00', date_to: '2026-10-23' } },
  { label: '日期为数字', args: { date_from: 20261001, date_to: '2026-10-23' } },
  { label: 'keyword 21 字', args: { ...DATES, keyword: '奶'.repeat(21) } },
  { label: 'limit 0', args: { ...DATES, limit: 0 } },
  { label: 'limit 9', args: { ...DATES, limit: 9 } },
  { label: 'limit 小数', args: { ...DATES, limit: 2.5 } },
  { label: 'limit 字符串', args: { ...DATES, limit: '3' } },
  { label: '普通多余字段', args: { ...DATES, status: 'PAID' } },
])(
  '[AC-B3-08a#1][BR-AI-03][BR-AI-07] list_my_orders $label 经注册表拒绝，不进 handler、不查订单、不告警',
  async ({ args }) => {
    const f = setup();
    expect(await f.execute(LIST, args)).toEqual(rejected);
    expect(f.listRun).not.toHaveBeenCalled();
    expect(f.searchForAgent).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it.each([
  { label: '只给必填', args: { ...DATES } },
  { label: 'keyword 20 字', args: { ...DATES, keyword: '奶'.repeat(20) } },
  { label: 'limit 1', args: { ...DATES, limit: 1 } },
  { label: 'limit 8', args: { ...DATES, limit: 8 } },
  { label: '带 platform', args: { ...DATES, platform: 'jd' } },
])('[AC-B3-08a#1][BR-AI-07] list_my_orders $label 通过 schema 进入 handler', async ({ args }) => {
  const f = setup();
  await f.execute(LIST, args);
  expect(f.listRun).toHaveBeenCalledTimes(1);
  expect(f.searchForAgent).toHaveBeenCalledTimes(1);
});

it.each([
  { label: 'card_id 与 order_no 同给', args: { card_id: 'c1', order_no: '990000000001' } },
  { label: '都不给', args: {} },
  { label: '只给 platform', args: { platform: 'jd' } },
  { label: 'platform 配 card_id', args: { card_id: 'c1', platform: 'jd' } },
  { label: '三者同给', args: { card_id: 'c1', order_no: '990000000001', platform: 'jd' } },
  { label: 'card_id 非字符串', args: { card_id: 1 } },
  { label: '普通多余字段', args: { card_id: 'c1', note: '合成' } },
])(
  '[AC-B3-08a#1][BR-AI-03][BR-AI-07] explain_order $label 经注册表拒绝，不进 handler、不扣次数、不查订单',
  async ({ args }) => {
    const f = setup();
    expect(await f.execute(EXPLAIN, args)).toEqual(rejected);
    expect(f.explainRun).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.take).not.toHaveBeenCalled();
    expect(f.findOwnByNumber).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it.each([
  { label: '只给 card_id', args: { card_id: 'c1' } },
  { label: '只给 order_no', args: { order_no: '990000000001' } },
  { label: 'order_no 配 platform', args: { order_no: '990000000001', platform: 'jd' } },
])('[AC-B3-08a#1][BR-AI-07] explain_order $label 通过 schema 进入 handler', async ({ args }) => {
  const f = setup();
  await f.execute(EXPLAIN, args);
  expect(f.explainRun).toHaveBeenCalledTimes(1);
});

it.each([
  { tool: LIST, field: 'user_id', args: { ...DATES, user_id: 'synthetic-forged' } },
  {
    tool: EXPLAIN,
    field: 'user_id',
    args: { order_no: '990000000001', user_id: 'synthetic-forged' },
  },
  { tool: EXPLAIN, field: 'app_id', args: { card_id: 'c1', app_id: 'synthetic-forged' } },
])(
  '[AC-B3-08a#1][BR-AI-03] $tool 带身份字段 $field 整次拒绝并告警一次',
  async ({ tool, args }) => {
    const f = setup();
    expect(await f.execute(tool, args)).toEqual(rejected);
    expect(f.listRun).not.toHaveBeenCalled();
    expect(f.explainRun).not.toHaveBeenCalled();
    expect(f.searchForAgent).not.toHaveBeenCalled();
    expect(f.findOwnByNumber).not.toHaveBeenCalled();
    expect(f.take).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent.identity_arg', tool }),
      'agent.identity_arg',
    );
  },
);

it.each([
  { label: '游客', userId: null, phoneBound: false },
  { label: '未绑手机', userId: 'synthetic-unbound', phoneBound: false },
  { label: '无用户但标记已绑', userId: null, phoneBound: true },
])(
  '[AC-B3-08a#2][BR-AI-01] $label 收不到两个工具，强行执行也拒绝且不触达任何端口',
  async ({ userId, phoneBound }) => {
    const f = setup();
    expect(f.list.audience).toBe('phone_bound');
    expect(f.explain.audience).toBe('phone_bound');
    const ctx = context({ userId, phoneBound });
    expect(await f.registry.definitions(ctx.appId, caller(ctx))).toEqual([]);
    expect(await f.execute(LIST, { ...DATES }, ctx)).toEqual(rejected);
    expect(await f.execute(EXPLAIN, { card_id: 'c1' }, ctx)).toEqual(rejected);
    expect(await f.execute(EXPLAIN, { order_no: '990000000001' }, ctx)).toEqual(rejected);
    expect(f.listRun).not.toHaveBeenCalled();
    expect(f.explainRun).not.toHaveBeenCalled();
    expect(f.searchForAgent).not.toHaveBeenCalled();
    expect(f.findOwnByNumber).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.take).not.toHaveBeenCalled();
  },
);

it('[AC-B3-08a#2][BR-AI-01] 已绑手机主体只在各自开关明确为 true 时收到对应工具', async () => {
  const get = vi.fn<ToolRegistryDeps['switches']['get']>();
  const f = setup({}, { get });
  const ctx = context();
  for (const [listOn, explainOn] of [
    [true, true],
    [true, undefined],
    [false, true],
    [undefined, false],
  ] as const) {
    get.mockImplementation(async (_appId, key) =>
      key === `agent.tools.${LIST}.enabled` ? listOn : explainOn,
    );
    const names = (await f.registry.definitions(ctx.appId, caller(ctx))).map(
      (definition) => definition.name,
    );
    expect(names.sort()).toEqual(
      [...(listOn === true ? [LIST] : []), ...(explainOn === true ? [EXPLAIN] : [])].sort(),
    );
  }
  expect(get).toHaveBeenCalledWith(ctx.appId, `agent.tools.${LIST}.enabled`);
  expect(get).toHaveBeenCalledWith(ctx.appId, `agent.tools.${EXPLAIN}.enabled`);
});

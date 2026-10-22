import { expect, it, vi } from 'vitest';
import {
  createLocalEvalAgent,
  createPortTools,
  decodeToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { RecordingMiss } from '../../../../packages/evals/src/replay.ts';
import {
  DEFINITION,
  GOOD,
  TOOL_ARGS,
  catalog,
  context,
  dependencies,
  fileText,
  input,
  modelOptions,
  ports,
  textOf,
} from './kit.ts';

it('[AC-B3-05m#2][BR-AI-21] 输入审核只收到脱敏文本，链接不进入审核也不进入模型', async () => {
  const review = vi.fn(async (text: string) => {
    void text;
    return 'pass' as const;
  });
  const agent = createLocalEvalAgent(dependencies({ ...modelOptions(), review: { review } }));
  const live = ports();
  const output = await agent(
    input({ text: '合成用户电话13800138000 https://example.invalid/synthetic' }),
    live,
  );
  expect(review).toHaveBeenCalledTimes(1);
  const checked = review.mock.calls[0]![0];
  expect(checked).toContain('138****8000');
  expect(checked).not.toContain('13800138000');
  expect(checked).not.toContain('example.invalid');
  expect(live.model).not.toHaveBeenCalled();
  expect(output.frames.at(-1)).toMatchObject({
    event: 'done',
    data: { finish_reason: 'fallback' },
  });
});

it.each(['block', 'throw'] as const)(
  '[AC-B3-05m#2][BR-AI-21] 输入审核 %s 走生产安全拒答',
  async (verdict) => {
    const review = vi.fn(async () => {
      if (verdict === 'throw') throw new Error('synthetic review unavailable');
      return verdict;
    });
    const agent = createLocalEvalAgent(dependencies({ review: { review } }));
    const live = ports();
    const output = await agent(input(), live);
    expect(review).toHaveBeenCalledTimes(1);
    expect(textOf(output)).toBe(
      fileText(verdict === 'block' ? 'agent.refuse.unsafe' : 'agent.refuse.safety_unavailable'),
    );
    expect(output.frames.at(-1)).toMatchObject({
      event: 'done',
      data: { finish_reason: 'safety' },
    });
    expect(live.model).not.toHaveBeenCalled();
    expect(live.tool).not.toHaveBeenCalled();
  },
);

it('[AC-B3-05m#2][BR-AI-21] 默认审核替身放行不绕过真实禁询词检查', async () => {
  const agent = createLocalEvalAgent(dependencies());
  const live = ports();
  const output = await agent(input({ text: '合成测试：购买枪支' }), live);
  expect(textOf(output)).toBe(fileText('agent.refuse.prohibited'));
  expect(output.frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'safety' } });
  expect(live.model).not.toHaveBeenCalled();
  expect(live.tool).not.toHaveBeenCalled();
});

it('[AC-B3-05m#3][BR-AI-21] 工具参数原样发送一次，录制状态携带 turn 与完整工具集', async () => {
  const live = ports();
  const definitions = [DEFINITION, { ...DEFINITION, name: 'synthetic_aux' }];
  const tools = createPortTools(live.tool, catalog(definitions), 3);
  const ctx = context();
  expect(await tools.definitions(ctx.subject.appId, ctx.subject)).toEqual(definitions);
  const expectedArgs = { ...TOOL_ARGS, reference: '<num_1>', nested: { value: '<num_1>' } };
  const args = structuredClone(expectedArgs);
  expect(await tools.execute({ id: 'synthetic-call', name: DEFINITION.name, args }, ctx)).toEqual(
    GOOD,
  );
  expect(live.tool).toHaveBeenCalledTimes(1);
  expect(live.tool.mock.calls[0]![0]).toEqual({
    name: 'search_products',
    args: expectedArgs,
    state: { turn: 3, result_set_ids: [], tool_set: ['search_products', 'synthetic_aux'] },
    config_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(args).toEqual(expectedArgs);
});

it('[AC-B3-05m#3][BR-AI-21] 相同定义跨实例指纹稳定，描述或参数结构变化改变指纹', async () => {
  const live = ports();
  const ctx = context();
  const definitions = [
    DEFINITION,
    structuredClone(DEFINITION),
    { ...DEFINITION, description: '合成新版描述' },
    { ...DEFINITION, parameters: { type: 'object', required: ['q'] } },
  ];
  for (const definition of definitions) {
    const tools = createPortTools(live.tool, catalog([definition]), 1);
    await tools.definitions(ctx.subject.appId, ctx.subject);
    await tools.execute({ id: 'synthetic-call', name: DEFINITION.name, args: TOOL_ARGS }, ctx);
  }
  const hashes = live.tool.mock.calls.map(([call]) => call.config_fingerprint);
  expect(hashes).toHaveLength(4);
  expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  expect(hashes[0]).toBe(hashes[1]);
  expect(hashes[2]).not.toBe(hashes[0]);
  expect(hashes[3]).not.toBe(hashes[0]);
});

it.each([
  null,
  [],
  { kind: 'other', modelView: {} },
  { kind: 'ok' },
  { kind: 'ok', modelView: {}, cards: [{}] },
  { kind: 'ok', modelView: {}, trace: { card_sources: 'bad' } },
  { kind: 'rejected', modelView: { error: 'other' } },
])('[AC-B3-05m#3][BR-AI-21] 非法工具录制拒绝解码 %j', (response) => {
  expect(decodeToolOutcome(response)).toBeNull();
});

it.each([
  GOOD,
  { kind: 'failed', modelView: { reason: 'synthetic' } },
  { kind: 'rejected', modelView: { error: 'invalid_args' } },
])('[AC-B3-05m#3][BR-AI-21] 合法工具结果无损解码 %j', (response) => {
  expect(decodeToolOutcome(response)).toEqual(response);
});

it('[AC-B3-05m#3][BR-AI-21] ok 录制省略 cards 时解码为空列表', () => {
  expect(decodeToolOutcome({ kind: 'ok', modelView: {} })).toEqual({
    kind: 'ok',
    modelView: {},
    cards: [],
  });
});

it('[AC-B3-05m#3][BR-AI-21] 模型实际调用一次工具，解码失败记 failed 且仍有终帧', async () => {
  const agent = createLocalEvalAgent(dependencies(modelOptions()));
  const live = ports({ malformed: '合成坏响应' });
  const output = await agent(input({ turn: 4 }), live);
  expect(live.tool).toHaveBeenCalledTimes(1);
  expect(live.tool.mock.calls[0]![0]).toMatchObject({
    args: TOOL_ARGS,
    state: { turn: 4, result_set_ids: [], tool_set: ['search_products'] },
  });
  expect(output.trace.tool_calls).toHaveLength(1);
  expect(output.trace.tool_calls[0]).toMatchObject({ name: 'search_products', status: 'failed' });
  expect(output.frames.at(-1)?.event).toBe('done');
  expect(live.model).toHaveBeenCalledTimes(2);
});

it('[AC-B3-05m#3][BR-AI-21] 工具 RecordingMiss 经整个生产工具循环仍原样逃出', async () => {
  const agent = createLocalEvalAgent(dependencies(modelOptions()));
  const live = ports();
  const missing = new RecordingMiss('tool', 'a'.repeat(64));
  live.tool.mockRejectedValue(missing);
  await expect(agent(input(), live)).rejects.toBe(missing);
  expect(live.tool).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05m#3][BR-AI-21] 工具录制的卡片与评测证据穿过生产装配，不能只留下 modelView', async () => {
  const card = {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
    fallback_text: '合成工具卡片',
  };
  const trace = {
    card_sources: [{ card_id: 'c1', fields: { synthetic_count: 7 } }],
    link_registrations: [{ link_id: 'synthetic-link', product_key: 'synthetic-product', ok: true }],
  };
  const response = { kind: 'ok' as const, modelView: { synthetic: true }, cards: [card], trace };
  expect(decodeToolOutcome(response)).toEqual(response);
  const agent = createLocalEvalAgent(dependencies(modelOptions()));
  const live = ports(response);
  const output = await agent(input(), live);
  expect(live.tool).toHaveBeenCalledTimes(1);
  expect(output.frames.filter((frame) => frame.event === 'card')).toMatchObject([
    { data: { ...card, card_id: 'c1' } },
  ]);
  expect(output.trace).toMatchObject(trace);
  expect(output.trace.tool_calls).toMatchObject([{ name: 'search_products', status: 'ok' }]);
});

it('[AC-B3-05m#3][BR-AI-21] 降级关键词搜索经保留端口名，证据通过 onTrace 汇入且不计模型工具调用', async () => {
  const trace = {
    card_sources: [{ card_id: 'c1', fields: { synthetic_count: 0 } }],
    link_registrations: [{ link_id: 'synthetic-link', product_key: 'synthetic-product', ok: true }],
  };
  const agent = createLocalEvalAgent(
    dependencies({
      catalog: {
        definitions: async () => [],
        enabledSearchPlatforms: async () => ['taobao'],
      },
    }),
  );
  const live = ports({
    kind: 'ok',
    modelView: { results: [{ platform: 'taobao', ok: true, items: [] }] },
    cards: [],
    trace,
  });
  const output = await agent(input({ turn: 2 }), live);
  expect(live.model).not.toHaveBeenCalled();
  expect(live.tool).toHaveBeenCalledTimes(1);
  expect(live.tool.mock.calls[0]![0]).toEqual({
    name: 'degraded_keyword_search',
    args: { q: '合成保温杯', platforms: ['taobao'], sort: 'relevance' },
    state: { turn: 2, result_set_ids: [], tool_set: [] },
    config_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(output.trace).toMatchObject({ ...trace, tool_calls: [] });
  expect(output.frames.at(-1)).toMatchObject({
    event: 'done',
    data: { finish_reason: 'fallback' },
  });
});

it('[AC-B3-05m#3][BR-AI-21] 降级关键词搜索的 RecordingMiss 也原样逃出', async () => {
  const agent = createLocalEvalAgent(
    dependencies({
      catalog: {
        definitions: async () => [],
        enabledSearchPlatforms: async () => ['taobao'],
      },
    }),
  );
  const live = ports();
  const missing = new RecordingMiss('tool', 'b'.repeat(64));
  live.tool.mockRejectedValue(missing);
  await expect(agent(input(), live)).rejects.toBe(missing);
  expect(live.tool).toHaveBeenCalledTimes(1);
});

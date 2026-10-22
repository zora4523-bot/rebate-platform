import { expect, it, vi } from 'vitest';
import {
  canonicalJson,
  fixedClock,
  loadRecordings,
  runRecord,
  runReplay,
  sequentialIds,
} from '../../../packages/evals/src/index.ts';
import type {
  AgentUnderTest,
  ModelRequest,
  TurnOutput,
} from '../../../packages/evals/src/index.ts';
import { AT, call, clock, digest, jsonl, output, request, runMeta, sample } from './kit.ts';

it('[AC-B3-01h#3][BR-AI-21] 多题、多轮、多工具录制后可完整回放，响应参与后续请求和判分', async () => {
  const cases = [
    sample({
      id: 'synthetic-multi-a',
      turns: [{ text: '合成首轮' }, { text: '合成次轮' }],
      expect: { intent: 'search', tools: [{ name: 'parse_input' }, { name: 'search_products' }] },
    }),
    sample({
      id: 'synthetic-multi-b',
      turns: [{ text: '合成失败题' }],
      expect: { intent: 'refine' },
    }),
  ];
  const seen: TurnOutput[] = [];
  const agent: AgentUnderTest = async (input, ports) => {
    const first = (await ports.model(
      request({ messages: [{ text: input.text, turn: input.turn }] }),
    )) as { query: string };
    const parsed = await ports.tool(
      call({
        name: 'parse_input',
        args: { text: first.query },
        state: {
          turn: input.turn,
          result_set_ids: [],
          tool_set: ['parse_input', 'search_products'],
        },
      }),
    );
    const products = await ports.tool(
      call({
        args: { parsed },
        state: { turn: input.turn, result_set_ids: [], tool_set: ['search_products'] },
      }),
    );
    const answer = (await ports.model(request({ messages: [{ products, turn: input.turn }] }))) as {
      text: string;
    };
    const out = output([answer.text], {
      trace: {
        intent: 'search',
        tool_calls: [
          { name: 'parse_input', args: { text: first.query }, status: 'ok' },
          { name: 'search_products', args: { parsed }, status: 'ok' },
        ],
      },
    });
    seen.push(out);
    return out;
  };
  const live = {
    model: vi.fn(async (req: ModelRequest) =>
      req.messages.length > 0 && Object.hasOwn(req.messages[0] as object, 'products')
        ? { text: '合成回答' }
        : { query: '合成查询' },
    ),
    tool: vi.fn(async () => ({ result: '合成工具结果' })),
  };
  const recorded = await runRecord({ cases, agent, live, meta: runMeta(cases), clock });
  expect(recorded.problems).toEqual([]);
  expect(recorded.report.cases.map((c) => c.result)).toEqual(['pass', 'fail']);
  expect(live.model).toHaveBeenCalledTimes(6);
  expect(live.tool).toHaveBeenCalledTimes(6);
  expect(recorded.recordings.length).toBeGreaterThan(0);
  const firstOutputs = structuredClone(seen);
  seen.length = 0;
  const loaded = loadRecordings(jsonl(recorded.recordings), 'synthetic.jsonl');
  expect(loaded.problems).toEqual([]);
  const replayed = await runReplay({
    cases,
    agent,
    store: loaded.store,
    meta: { ...runMeta(cases), mode: 'A', recordings_sha256: digest(jsonl(recorded.recordings)) },
  });
  expect(replayed.cases).toEqual(recorded.report.cases);
  expect(replayed.summary).toEqual(recorded.report.summary);
  expect(seen).toEqual(firstOutputs);
  expect(replayed.cases.flatMap((c) => c.problems).some((p) => p.code === 'recording_miss')).toBe(
    false,
  );
  expect(loaded.store.unused()).toEqual([]);
  expect(live.model).toHaveBeenCalledTimes(6);
  expect(live.tool).toHaveBeenCalledTimes(6);
});

it.each([undefined, 'real_link_sample'] as const)(
  '[AC-B3-01h#5][BR-AI-21] agent provenance=%s 时 live 收到可信题目来源，键仍覆盖原请求',
  async (provenance) => {
    const cases = [sample({ provenance: 'vendor_synthetic' })];
    const req = request(provenance === undefined ? {} : { provenance });
    const before = structuredClone(req);
    const model = vi.fn(async () => ({ answer: '合成响应' }));
    const agent: AgentUnderTest = async (_input, ports) => {
      await ports.model(req);
      return output();
    };
    const result = await runRecord({
      cases,
      agent,
      live: { model, tool: async () => null },
      meta: runMeta(cases),
      clock,
    });
    expect(model.mock.calls).toEqual([[{ ...req, provenance: 'vendor_synthetic' }]]);
    expect(req).toEqual(before);
    // canonicalJson 是既有共用规范；不调用新 writer 或 modelKey 求期望键。
    expect(result.recordings).toEqual([
      {
        kind: 'model',
        key: digest(canonicalJson(before)),
        response: { answer: '合成响应' },
        recorded_at: AT,
      },
    ]);
    expect(result.report.cases.map((c) => c.result)).toEqual(['pass']);
    expect(result.problems).toEqual([]);
    const loaded = loadRecordings(jsonl(result.recordings), 'synthetic.jsonl');
    const replayed = await runReplay({
      cases,
      agent,
      store: loaded.store,
      meta: { ...runMeta(cases), mode: 'A' },
    });
    expect(replayed.cases.map((c) => c.result)).toEqual(['pass']);
    expect(loaded.store.unused()).toEqual([]);
  },
);

it('[AC-B3-01h#2][BR-AI-21] runRecord 返回的模型与工具录制剥离嵌套身份和鉴权字段，其余原样', async () => {
  const cases = [sample()];
  const response = {
    user_id: 'SYNTHETIC-RUNNER-USER-SECRET',
    nested: [
      {
        device_id: 'SYNTHETIC-RUNNER-DEVICE-SECRET',
        headers: {
          authorization: 'Bearer sk-SYNTHETIC-RUNNER-AUTH',
          'x-api-key': 'sk-SYNTHETIC-RUNNER-API',
          cookie: 'SYNTHETIC-RUNNER-COOKIE-SECRET',
          accept: 'application/json',
        },
        keep: ['合成公开商品', 0, false, null],
      },
    ],
  };
  const before = structuredClone(response);
  const model = vi.fn(async () => response);
  const tool = vi.fn(async () => response);
  const agent: AgentUnderTest = async (_input, ports) => {
    await ports.model(request());
    await ports.tool(call());
    return output();
  };
  const result = await runRecord({
    cases,
    agent,
    live: { model, tool },
    meta: runMeta(cases),
    clock,
  });
  expect(result.report.cases.map((c) => c.result)).toEqual(['pass']);
  expect(result.problems).toEqual([]);
  expect(model).toHaveBeenCalledTimes(1);
  expect(tool).toHaveBeenCalledTimes(1);
  expect(result.recordings.map((r) => r.kind)).toEqual(['model', 'tool']);
  for (const record of result.recordings) {
    expect(record.response).toEqual({
      nested: [{ headers: { accept: 'application/json' }, keep: ['合成公开商品', 0, false, null] }],
    });
  }
  const serialized = JSON.stringify(result.recordings);
  for (const secret of [
    'user_id',
    'device_id',
    'authorization',
    'x-api-key',
    'cookie',
    response.user_id,
    response.nested[0]!.device_id,
    response.nested[0]!.headers.authorization,
    response.nested[0]!.headers['x-api-key'],
    response.nested[0]!.headers.cookie,
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect(response).toEqual(before);
});

it('[AC-B3-01h#4][BR-AI-21] runRecord 汇总冲突且 live 错误仍可被 agent 捕获', async () => {
  const cases = [sample()];
  const failure = new Error('合成工具失败');
  const caught: unknown[] = [];
  const model = vi
    .fn()
    .mockResolvedValueOnce({ text: '合成甲' })
    .mockResolvedValueOnce({ text: '合成乙' });
  const agent: AgentUnderTest = async (_input, ports) => {
    await ports.model(request());
    await ports.model(request());
    try {
      await ports.tool(call());
    } catch (error) {
      caught.push(error);
    }
    return output();
  };
  const result = await runRecord({
    cases,
    agent,
    live: {
      model,
      tool: async () => {
        throw failure;
      },
    },
    meta: runMeta(cases),
    clock,
  });
  expect(caught).toEqual([failure]);
  expect(caught[0]).toBe(failure);
  expect(result.report.cases.map((c) => c.result)).toEqual(['pass']);
  expect(result.problems.map((p) => p.code)).toEqual(['recording_conflict']);
  expect(result.recordings).toHaveLength(1);
  expect(result.recordings[0]?.response).toEqual({ text: '合成甲' });
});

it('[AC-B3-01h#9][BR-AI-21] 固定时钟输出指定瞬间，序列 id 从一开始且实例互不干扰', () => {
  const fixed = fixedClock('2026-10-22T11:04:05+08:00');
  expect(fixed.now().toISOString()).toBe(AT);
  expect(fixed.now().toISOString()).toBe(AT);
  const one = sequentialIds('synthetic');
  expect([one.next(), one.next(), one.next()]).toEqual([
    'synthetic-1',
    'synthetic-2',
    'synthetic-3',
  ]);
  const two = sequentialIds('synthetic');
  expect(two.next()).toBe('synthetic-1');
  expect(one.next()).toBe('synthetic-4');
});

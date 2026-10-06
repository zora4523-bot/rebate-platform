import { expect, it, vi } from 'vitest';
import {
  computeManifest,
  loadRecordings,
  modelKey,
  runCandidate,
  runIntegration,
  toolKey,
} from '../../../packages/evals/src/index.ts';
import type {
  AgentPorts,
  EvalCase,
  ReleaseAgent,
  ReleaseExpectation,
  ReleaseReport,
  ReleaseRunOptions,
} from '../../../packages/evals/src/index.ts';
import { call, jsonl, meta, output, recording, request, sample } from '../evals-replay/fixtures.ts';
import { earningsFixture, expectationDigest } from './fixtures.ts';

function options(cases: EvalCase[], agent: ReleaseAgent): ReleaseRunOptions {
  return {
    cases,
    expectations: cases.filter((c) => !c.retired).map((c) => ({ case_id: c.id })),
    agent,
    meta: meta(computeManifest('smoke', 'synthetic-v1', cases)),
    model: vi.fn(async () => ({ synthetic: 'model-response' })),
  };
}

it('[AC-B3-01c-B01#1] B 模式模型走注入端口，工具按内容回放，录制模型不得代答', async () => {
  const req = request();
  const tool = call();
  const store = loadRecordings(
    jsonl([
      recording({ key: modelKey(req), response: { synthetic: 'must-not-use' } }),
      recording({ kind: 'tool', key: toolKey(tool), response: { synthetic: 'recorded-tool' } }),
    ]),
    'synthetic.jsonl',
  ).store;
  const seen: unknown[] = [];
  const opts = options([sample()], async (_input, ports) => {
    seen.push(await ports.model(req), await ports.tool(tool));
    return output();
  });
  const report = await runCandidate({ ...opts, store });
  expect(seen).toEqual([{ synthetic: 'model-response' }, { synthetic: 'recorded-tool' }]);
  expect(opts.model).toHaveBeenCalledExactlyOnceWith(req);
  expect(report.meta).toMatchObject({
    ...opts.meta,
    mode: 'B',
    unused_recordings: 1,
    recordings_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(report.expectations_sha256).toBe(expectationDigest(opts.expectations));
  expect(report.cases[0]).toMatchObject({ result: 'pass', metrics: { amount_in_text: 'pass' } });
});

it('[AC-B3-01c-B02#1] B 模式录制按实际请求内容查找，调用倒序或重复也拿到对应响应', async () => {
  const a = call({ args: { q: '合成甲' } });
  const b = call({ args: { q: '合成乙' } });
  const store = loadRecordings(
    jsonl([
      recording({ kind: 'tool', key: toolKey(a), response: 'a' }),
      recording({ kind: 'tool', key: toolKey(b), response: 'b' }),
    ]),
    'synthetic.jsonl',
  ).store;
  const seen: unknown[] = [];
  const opts = options([sample()], async (_input, ports) => {
    seen.push(await ports.tool(b), await ports.tool(a), await ports.tool(b));
    return output();
  });
  const report = await runCandidate({ ...opts, store });
  expect(seen).toEqual(['b', 'a', 'b']);
  expect(report.cases[0]?.result).toBe('pass');
});

it.each(['args', 'turn', 'result_set', 'tool_set', 'config'] as const)(
  '[AC-B3-01c-B03#1] B 工具请求 %s 改变不能误取旧录制，吞掉未命中仍是覆盖缺口',
  async (change) => {
    const original = call();
    const altered = structuredClone(original);
    if (change === 'args') altered.args['q'] = '另一商品';
    if (change === 'turn') altered.state.turn = 2;
    if (change === 'result_set') altered.state.result_set_ids = ['another'];
    if (change === 'tool_set') altered.state.tool_set = [];
    if (change === 'config') altered.config_fingerprint = 'another';
    const cases = [
      sample({
        id: 'a-miss',
        expect: { intent: 'find_by_link' },
        turns: [{ text: '首轮' }, { text: '不应运行' }],
      }),
      sample({ id: 'z-ok' }),
    ];
    const calls: string[] = [];
    const opts = options(cases, async (input, ports) => {
      calls.push(`${input.case_id}:${input.turn}`);
      if (input.case_id === 'a-miss') await ports.tool(altered).catch(() => undefined);
      return output();
    });
    const store = loadRecordings(
      jsonl([recording({ kind: 'tool', key: toolKey(original) })]),
      'synthetic.jsonl',
    ).store;
    const report = await runCandidate({ ...opts, store });
    expect(calls).toEqual(['a-miss:1', 'z-ok:1']);
    expect(report.cases[0]).toMatchObject({
      result: 'coverage_gap',
      metrics: {
        recognition: 'coverage_gap',
        platform: 'coverage_gap',
        multi_turn: 'coverage_gap',
      },
    });
    expect(report.cases[1]?.result).toBe('pass');
  },
);

it('[AC-B3-01c-I01#1] 集成模式调用注入的服务端工具与模型，并判分完整卡片和 trace', async () => {
  const f = earningsFixture();
  const response = { synthetic: 'server-tool-and-guards' };
  const tool = vi.fn(async () => response);
  const seen: unknown[] = [];
  const opts = options([f.c], async (_input, ports) => {
    seen.push(await ports.model(request()), await ports.tool(call()));
    return f.outputs[0]!;
  });
  opts.expectations = [f.expectation];
  const report = await runIntegration({ ...opts, tool });
  expect(tool).toHaveBeenCalledExactlyOnceWith(call());
  expect(opts.model).toHaveBeenCalledExactlyOnceWith(request());
  expect(seen).toEqual([{ synthetic: 'model-response' }, response]);
  expect(report.cases[0]).toMatchObject({
    result: 'pass',
    metrics: { card_values: 'pass', parameters: 'pass' },
  });
  expect(report.meta).toMatchObject({
    mode: 'integration',
    recordings_sha256: null,
    unused_recordings: 0,
  });
});

it('[AC-B3-01c-I02] 集成运行器不能漏接卡片数值判分', async () => {
  const f = earningsFixture();
  f.outputs[0]!.trace.sources![0]!.data['withdrawable_fen'] = 0;
  const opts = options([f.c], async () => f.outputs[0]!);
  opts.expectations = [f.expectation];
  const report = await runIntegration({ ...opts, tool: async () => null });
  expect(report.cases[0]).toMatchObject({ result: 'fail', metrics: { card_values: 'fail' } });
});

it.each(['B', 'integration'] as const)(
  '[AC-B3-01c-U01#1] %s 按题号、轮次运行，保留完整输入，跳过退役题',
  async (mode) => {
    const cases = [
      sample({ id: 'z-last' }),
      sample({
        id: 'a-first',
        subject: 'bound_phone',
        switches: { synthetic: true },
        turns: [{ text: '首轮', untrusted: true }, { text: '第二轮' }],
      }),
      sample({ id: 'retired', retired: { at: '2026-10-06', reason: '合成退役' } }),
    ];
    const seen: Parameters<ReleaseAgent>[0][] = [];
    const opts = options(cases, async (input) => {
      seen.push(input);
      return output();
    });
    const report =
      mode === 'B'
        ? await runCandidate({ ...opts, store: loadRecordings('', 'empty.jsonl').store })
        : await runIntegration({ ...opts, tool: async () => null });
    expect(seen.map((i) => [i.case_id, i.turn])).toEqual([
      ['a-first', 1],
      ['a-first', 2],
      ['z-last', 1],
    ]);
    expect(seen[0]).toEqual({
      case_id: 'a-first',
      turn: 1,
      text: '首轮',
      untrusted: true,
      subject: 'bound_phone',
      switches: { synthetic: true },
    });
    expect(report.cases.map((c) => c.id)).toEqual(['a-first', 'z-last']);
    expect(report.cases[0]?.metrics.multi_turn).toBe('pass');
  },
);

it.each(['B', 'integration'] as const)(
  '[AC-B3-01c-U02#1] %s 模型失败即使被吞掉也保留错误，停止该题继续下一题',
  async (mode) => {
    const cases = [
      sample({ id: 'a-error', turns: [{ text: '首轮' }, { text: '不该运行' }] }),
      sample({ id: 'z-ok' }),
    ];
    const seen: string[] = [];
    const opts = options(cases, async (input, ports) => {
      seen.push(`${input.case_id}:${input.turn}`);
      if (input.case_id === 'a-error') await ports.model(request()).catch(() => undefined);
      return output();
    });
    opts.model = async () => {
      throw new Error('synthetic adapter failure');
    };
    const report =
      mode === 'B'
        ? await runCandidate({ ...opts, store: loadRecordings('', 'empty.jsonl').store })
        : await runIntegration({ ...opts, tool: async () => null });
    expect(seen).toEqual(['a-error:1', 'z-ok:1']);
    expect(report.cases[0]).toMatchObject({ result: 'error', metrics: { multi_turn: 'error' } });
    expect(report.cases[1]?.result).toBe('pass');
  },
);

it('[AC-B3-01c-U03] 集成工具异常即使 Agent 吞掉也不能判为成功', async () => {
  const opts = options([sample()], async (_input, ports) => {
    await ports.tool(call()).catch(() => undefined);
    return output();
  });
  const report = await runIntegration({
    ...opts,
    tool: async () => {
      throw new Error('synthetic tool failure');
    },
  });
  expect(report.cases[0]?.result).toBe('error');
});

it.each(['B', 'integration'] as const)(
  '[AC-B3-01c-U04#1] %s 超时停止后续轮、保留适用指标并继续别题',
  async (mode) => {
    vi.useFakeTimers();
    try {
      const cases = [
        sample({
          id: 'a-timeout',
          expect: { intent: 'find_by_link' },
          turns: [{ text: '第一轮' }, { text: '不可执行' }],
        }),
        sample({ id: 'z-ok' }),
      ];
      const opts = options(cases, (input) =>
        input.case_id === 'a-timeout' ? new Promise(() => {}) : Promise.resolve(output()),
      );
      opts.timeoutMs = 25;
      const pending: Promise<ReleaseReport> =
        mode === 'B'
          ? runCandidate({ ...opts, store: loadRecordings('', 'empty.jsonl').store })
          : runIntegration({ ...opts, tool: async () => null });
      await vi.advanceTimersByTimeAsync(25);
      const report = await pending;
      expect(report.cases[0]).toMatchObject({
        result: 'error',
        problems: [expect.objectContaining({ code: 'timeout', turn: 1 })],
        metrics: { recognition: 'error', platform: 'error', multi_turn: 'error' },
      });
      expect(report.cases[1]?.result).toBe('pass');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('[AC-B3-01c-U05#1] B 模式跨两次运行复用旧端口的未命中仍归到当前题', async () => {
  let cached: AgentPorts | undefined;
  const agent: ReleaseAgent = async (_input, ports) => {
    if (cached === undefined) cached = ports;
    else await cached.tool(call({ args: { q: '没有录制的合成请求' } })).catch(() => undefined);
    return output();
  };
  const opts = options([sample()], agent);
  const store = loadRecordings('', 'empty.jsonl').store;
  const first = await runCandidate({ ...opts, store });
  const second = await runCandidate({ ...opts, store });
  expect(first.cases[0]?.result).toBe('pass');
  expect(second.cases[0]?.result).toBe('coverage_gap');
});

it.each(['missing', 'duplicate'] as const)(
  '[AC-B3-01c-U06] 运行前参考答案 %s 时不能调用模型后生成貌似有效的报告',
  async (change) => {
    const agent = vi.fn(async () => output());
    const opts = options([sample()], agent);
    const expectation: ReleaseExpectation = { case_id: opts.cases[0]!.id };
    opts.expectations = change === 'missing' ? [] : [expectation, expectation];
    await expect(runIntegration({ ...opts, tool: async () => null })).rejects.toThrow(
      /expectation|oracle|参考|答案/i,
    );
    expect(agent).not.toHaveBeenCalled();
    expect(opts.model).not.toHaveBeenCalled();
  },
);

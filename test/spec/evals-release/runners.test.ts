import { expect, it, vi } from 'vitest';
import {
  computeFacts,
  computeManifest,
  loadRecordings,
  modelKey,
  runEval,
  runReplay,
  toolKey,
} from '../../../packages/evals/src/index.ts';
import type { AgentPorts, AgentUnderTest, RunMeta } from '../../../packages/evals/src/index.ts';
import {
  call,
  card,
  jsonl,
  meta,
  output,
  recording,
  request,
  sample,
} from '../evals-replay/fixtures.ts';
import { count, fact } from './fixtures.ts';

function store() {
  return loadRecordings(
    jsonl([
      recording({ kind: 'model', key: modelKey(request()), response: 'recorded-model' }),
      recording({ kind: 'tool', key: toolKey(call()), response: 'recorded-tool' }),
    ]),
    'synthetic.jsonl',
  ).store;
}
function options(mode: RunMeta['mode'], cases = [sample()]) {
  return { cases, meta: { ...meta(computeManifest('smoke', 'synthetic-v1', cases)), mode } };
}

it.each(['A', 'B', 'integration'] as const)(
  '[B3-01c] [AC-B3-01c-R01] %s 合法端口来源，每轮请求得到对应响应',
  async (mode) => {
    const live = {
      model: vi.fn(async () => 'live-model'),
      tool: vi.fn(async () => 'live-tool'),
    };
    const seen: unknown[] = [];
    const agent: AgentUnderTest = async (_input, ports) => {
      seen.push(await ports.model(request()), await ports.tool(call()));
      return output();
    };
    const base = options(mode);
    const got = await runEval({
      ...base,
      agent,
      ...(mode === 'integration'
        ? { live }
        : { store: store(), ...(mode === 'B' ? { live: { model: live.model } } : {}) }),
    });
    expect(seen).toEqual([
      mode === 'A' ? 'recorded-model' : 'live-model',
      mode === 'integration' ? 'live-tool' : 'recorded-tool',
    ]);
    expect(live.model).toHaveBeenCalledTimes(mode === 'A' ? 0 : 1);
    expect(live.tool).toHaveBeenCalledTimes(mode === 'integration' ? 1 : 0);
    expect(got.report.cases.map((c) => c.result)).toEqual(['pass']);
    expect(got.facts).toEqual([fact(base.cases[0]!.id)]);
  },
);

it.each([
  { mode: 'A', live: { model: async () => null }, withStore: true },
  { mode: 'A', live: { tool: async () => null }, withStore: true },
  { mode: 'A', live: {}, withStore: false },
  { mode: 'B', live: { model: async () => null, tool: async () => null }, withStore: true },
  { mode: 'B', live: {}, withStore: true },
  { mode: 'B', live: { model: async () => null }, withStore: false },
  { mode: 'integration', live: { model: async () => null }, withStore: false },
  { mode: 'integration', live: { tool: async () => null }, withStore: false },
] satisfies { mode: RunMeta['mode']; live: Partial<AgentPorts>; withStore: boolean }[])(
  '[B3-01c] [AC-B3-01c-R02] 非法模式组合 $mode / $live / store=$withStore 在跑题前拒绝',
  async ({ mode, live, withStore }) => {
    const agent = vi.fn<AgentUnderTest>(async () => output());
    const pending = runEval({
      ...options(mode),
      agent,
      live,
      ...(withStore ? { store: store() } : {}),
    });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(/mode/);
    expect(agent).not.toHaveBeenCalled();
  },
);

it('[B3-01c] [AC-B3-01c-R03] A 模式 report 与同输入 runReplay 深相等，保留旧报告全部字段', async () => {
  const cases = [sample({ id: 'case-z' }), sample({ id: 'case-A' })];
  const agent: AgentUnderTest = async (_input, ports) => {
    await ports.model(request());
    return output();
  };
  const replay = await runReplay({ ...options('A', cases), agent, store: store() });
  const got = await runEval({ ...options('A', cases), agent, store: store(), live: {} });
  expect(got.report).toEqual(replay);
  expect(got.facts).toEqual([fact('case-A'), fact('case-z')]);
});

it('[B3-01c] [AC-B3-01c-R04] 未退役题各一条 facts，码元序；判分 fail 仍 graded，gap/error 清零', async () => {
  const cases = [
    sample({ id: 'case-z' }),
    sample({ id: 'case-a' }),
    sample({ id: 'case-Z' }),
    sample({ id: 'case-A' }),
    sample({ id: 'case-retired', retired: { at: '2026-10-06', reason: 'synthetic' } }),
  ];
  const seen: string[] = [];
  const rich = output([], { frames: [card(), ...output().frames] });
  rich.trace.card_sources = [{ card_id: 'c1', fields: { withdrawable_fen: 2990 } }];
  const agent: AgentUnderTest = async (input, ports) => {
    seen.push(input.case_id);
    if (input.case_id === 'case-Z') {
      await ports.tool(call({ name: 'not-recorded' })).catch(() => undefined);
      return rich;
    }
    if (input.case_id === 'case-a') throw new Error('synthetic agent failure');
    if (input.case_id === 'case-z')
      return output(['只要29元'], {
        trace: rich.trace,
        frames: [...rich.frames.slice(0, 1), ...output(['只要29元']).frames],
      });
    return rich;
  };
  const got = await runEval({
    ...options('B', cases),
    agent,
    store: store(),
    live: { model: async () => null },
  });
  expect(seen).toEqual(['case-A', 'case-Z', 'case-a', 'case-z']);
  expect(got.report.cases.map((c) => [c.id, c.result])).toEqual([
    ['case-A', 'pass'],
    ['case-Z', 'coverage_gap'],
    ['case-a', 'error'],
    ['case-z', 'fail'],
  ]);
  expect(got.facts).toEqual([
    fact('case-A', { card_values: count(1) }),
    fact('case-Z', { graded: false }),
    fact('case-a', { graded: false }),
    fact('case-z', { card_values: count(1) }),
  ]);
  expect(got.facts[0]).toEqual(computeFacts(cases[3]!, [rich]));
});

it.each(['B', 'integration'] as const)(
  '[B3-01c] [AC-B3-01c-R05] %s live 抛错被 Agent 吞掉后正常判分并继续后续轮',
  async (mode) => {
    const cases = [sample({ turns: [{ text: '合成第一轮' }, { text: '合成第二轮' }] })];
    const calls: number[] = [];
    const live = {
      model: vi.fn(async () => {
        throw new Error('synthetic live model');
      }),
      tool: vi.fn(async () => {
        throw new Error('synthetic live tool');
      }),
    };
    const agent: AgentUnderTest = async (input, ports) => {
      calls.push(input.turn);
      await ports.model(request()).catch(() => undefined);
      if (mode === 'integration') await ports.tool(call()).catch(() => undefined);
      return output();
    };
    const got = await runEval({
      ...options(mode, cases),
      agent,
      ...(mode === 'B' ? { store: store(), live: { model: live.model } } : { live }),
    });
    expect(calls).toEqual([1, 2]);
    expect(got.report.cases[0]?.result).toBe('pass');
    expect(got.facts).toEqual([fact(cases[0]!.id)]);
    expect(live.model).toHaveBeenCalledTimes(2);
    expect(live.tool).toHaveBeenCalledTimes(mode === 'integration' ? 2 : 0);
  },
);

it.each(['model', 'tool'] as const)(
  '[B3-01c] [AC-B3-01c-R06] live %s 抛错未被 Agent 吞掉则 error，facts 未判分',
  async (port) => {
    const cases = [sample()];
    const live = {
      model: async () => {
        throw new Error('synthetic live error');
      },
      tool: async () => {
        throw new Error('synthetic live error');
      },
    };
    const agent: AgentUnderTest = async (_input, ports) => {
      if (port === 'model') await ports.model(request());
      else await ports.tool(call());
      return output();
    };
    const got = await runEval({ ...options('integration', cases), agent, live });
    expect(got.report.cases[0]).toMatchObject({
      result: 'error',
      problems: [expect.objectContaining({ code: 'agent_error' })],
    });
    expect(got.facts).toEqual([fact(cases[0]!.id, { graded: false })]);
  },
);

it.each(['throw', 'swallow', 'old-port'] as const)(
  '[B3-01c] [AC-B3-01c-R07] 录制未命中 %s 始终 coverage_gap，后续轮不执行',
  async (kind) => {
    const cases = [sample({ turns: [{ text: '轮一' }, { text: '轮二' }, { text: '轮三' }] })];
    let old: AgentPorts | undefined;
    const turns: number[] = [];
    const agent: AgentUnderTest = async (input, ports) => {
      turns.push(input.turn);
      if (input.turn === 1) {
        old = ports;
        return output();
      }
      const pending = (kind === 'old-port' ? old! : ports).tool(call({ name: 'absent' }));
      if (kind === 'throw') await pending;
      else await pending.catch(() => undefined);
      return output();
    };
    const got = await runEval({
      ...options('B', cases),
      agent,
      store: store(),
      live: { model: async () => null },
    });
    expect(turns).toEqual([1, 2]);
    expect(got.report.cases[0]).toMatchObject({
      result: 'coverage_gap',
      problems: [expect.objectContaining({ code: 'recording_miss', turn: 2 })],
    });
    expect(got.facts).toEqual([fact(cases[0]!.id, { graded: false })]);
  },
);

it('[B3-01c] [AC-B3-01c-R08] 超时终止该题，facts 清零', async () => {
  const agent: AgentUnderTest = () => new Promise(() => undefined);
  const base = options('integration');
  const got = await runEval({
    ...base,
    agent,
    live: { model: async () => null, tool: async () => null },
    timeoutMs: 1,
  });
  expect(got.report.cases[0]).toMatchObject({
    result: 'error',
    problems: [expect.objectContaining({ code: 'timeout' })],
  });
  expect(got.facts).toEqual([fact(base.cases[0]!.id, { graded: false })]);
});

it('[B3-01c] [AC-B3-01c-R09] integration 提供 store 也只使用 live 端口', async () => {
  const seen: unknown[] = [];
  const agent: AgentUnderTest = async (_input, ports) => {
    seen.push(await ports.model(request()), await ports.tool(call()));
    return output();
  };
  const got = await runEval({
    ...options('integration'),
    agent,
    store: store(),
    live: { model: async () => 'live-model', tool: async () => 'live-tool' },
  });
  expect(seen).toEqual(['live-model', 'live-tool']);
  expect(got.report.cases[0]?.result).toBe('pass');
});

it.each(['coverage_gap', 'error'] as const)(
  '[B3-01c] [AC-B3-01c-R10] 首轮已有卡片证据，第二轮 %s 仍将整题 facts 清零',
  async (result) => {
    const cases = [sample({ turns: [{ text: '合成轮一' }, { text: '合成轮二' }] })];
    const rich = output([], { frames: [card(), ...output().frames] });
    rich.trace.card_sources = [{ card_id: 'c1', fields: { withdrawable_fen: 2990 } }];
    const agent: AgentUnderTest = async (input, ports) => {
      if (input.turn === 1) return rich;
      if (result === 'coverage_gap')
        await ports.tool(call({ name: 'absent' })).catch(() => undefined);
      else await ports.model(request());
      return output();
    };
    const got = await runEval({
      ...options('B', cases),
      agent,
      store: store(),
      live: {
        model: async () => {
          throw new Error('synthetic live failure');
        },
      },
    });
    expect(got.report.cases[0]?.result).toBe(result);
    expect(got.facts).toEqual([fact(cases[0]!.id, { graded: false })]);
  },
);

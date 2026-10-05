import { expect, it, vi } from 'vitest';
import {
  computeManifest,
  loadRecordings,
  modelKey,
  toolKey,
  RecordingMiss,
  runReplay,
} from '../../../packages/evals/src/index.ts';
import type { AgentUnderTest, Report } from '../../../packages/evals/src/index.ts';
import {
  call,
  identityFields,
  jsonl,
  meta,
  output,
  recording,
  request,
  sample,
} from './fixtures.ts';

it('[B3-01b] 运行器按 id 码元序、轮次顺序传完整输入；跳过退役题，题内状态可连续使用', async () => {
  const cases = [
    sample({ id: 'a-001' }),
    sample({ id: 'retired-001', retired: { at: '2026-10-05', reason: '合成退役' } }),
    sample({
      id: 'B-001',
      subject: 'bound_phone',
      switches: { synthetic: true },
      turns: [
        { text: '第一轮', untrusted: true },
        { text: '第二轮', untrusted: false },
      ],
    }),
  ];
  const inputs: Parameters<AgentUnderTest>[0][] = [];
  const session = new Map<string, number>();
  const agent: AgentUnderTest = async (input) => {
    inputs.push(input);
    const previous = session.get(input.case_id) ?? 0;
    if (previous !== input.turn - 1) throw new Error('synthetic session lost');
    session.set(input.case_id, input.turn);
    return output();
  };
  const runMeta = meta(computeManifest('smoke', 'synthetic-v1', cases));
  const report = await runReplay({
    cases,
    agent,
    store: loadRecordings('', 'empty.jsonl').store,
    meta: runMeta,
  });
  expect(inputs).toEqual([
    {
      case_id: 'B-001',
      turn: 1,
      text: '第一轮',
      untrusted: true,
      subject: 'bound_phone',
      switches: { synthetic: true },
    },
    {
      case_id: 'B-001',
      turn: 2,
      text: '第二轮',
      untrusted: false,
      subject: 'bound_phone',
      switches: { synthetic: true },
    },
    {
      case_id: 'a-001',
      turn: 1,
      text: cases[0]?.turns[0]?.text,
      untrusted: false,
      subject: 'guest',
      switches: {},
    },
  ]);
  expect(report.cases.map((c) => [c.id, c.result])).toEqual([
    ['B-001', 'pass'],
    ['a-001', 'pass'],
  ]);
  expect(report.schema_version).toBe(1);
  expect(report.meta).toEqual(runMeta);
  expect(report.summary).toMatchObject({ total: 2, pass: 2, fail: 0, coverage_gap: 0, error: 0 });
});

it('[B3-01b] ports.model/tool 返回 Promise、交回匹配响应；运行器填 unused 并判分', async () => {
  const req = request();
  const tool = call();
  const store = loadRecordings(
    jsonl([
      recording({ key: modelKey(req), response: { text: '模型合成响应' } }),
      recording({ kind: 'tool', key: toolKey(tool), response: { found: '工具合成响应' } }),
      recording({ key: 'e'.repeat(64) }),
    ]),
    'ports.jsonl',
  ).store;
  const seen: unknown[] = [];
  const promises: boolean[] = [];
  const agent: AgentUnderTest = async (_input, ports) => {
    const m = ports.model(req);
    const t = ports.tool(tool);
    promises.push(m instanceof Promise, t instanceof Promise);
    seen.push(await t, await m, await ports.model(req));
    return output(['9元']);
  };
  const cases = [sample()];
  const report = await runReplay({
    cases,
    agent,
    store,
    meta: meta(computeManifest('smoke', 'v1', cases)),
  });
  expect(promises).toEqual([true, true]);
  expect(seen).toEqual([
    { found: '工具合成响应' },
    { text: '模型合成响应' },
    { text: '模型合成响应' },
  ]);
  expect(report.meta.unused_recordings).toBe(1);
  expect(report.cases[0]).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
  expect(report.summary.counters.amount_in_text).toBe(1);
});

it.each(['model', 'tool'] as const)(
  '[B3-01b] %s 录制缺失为 coverage_gap，停止该题后续轮但继续别题',
  async (kind) => {
    const cases = [
      sample({ id: 'gap-001', turns: [{ text: '第一轮' }, { text: '不得调用' }] }),
      sample({ id: 'ok-001' }),
    ];
    const calls: string[] = [];
    const agent: AgentUnderTest = async (input, ports) => {
      calls.push(`${input.case_id}:${input.turn}`);
      if (input.case_id === 'gap-001') {
        if (kind === 'model') await ports.model(request());
        else await ports.tool(call());
      }
      return output();
    };
    const report = await runReplay({
      cases,
      agent,
      store: loadRecordings('', 'empty.jsonl').store,
      meta: meta(computeManifest('smoke', 'v1', cases)),
    });
    expect(calls).toEqual(['gap-001:1', 'ok-001:1']);
    expect(report.cases[0]).toMatchObject({
      result: 'coverage_gap',
      first_failed_layer: null,
      problems: [expect.objectContaining({ code: 'recording_miss', layer: null, turn: 1 })],
    });
    const message = report.cases[0]?.problems[0]?.message ?? '';
    expect(message).toContain(kind);
    expect(message).toContain(kind === 'model' ? modelKey(request()) : toolKey(call()));
    expect(report.cases[1]?.result).toBe('pass');
    expect(report.summary).toMatchObject({ total: 2, pass: 1, coverage_gap: 1, error: 0 });
  },
);

it('[B3-01b] Agent 自身抛 RecordingMiss 也为覆盖缺口，定位到实际失败轮', async () => {
  const cases = [sample({ turns: [{ text: '第一轮' }, { text: '第二轮' }, { text: '第三轮' }] })];
  const called: number[] = [];
  const agent: AgentUnderTest = async (input) => {
    called.push(input.turn);
    if (input.turn === 2) throw new RecordingMiss('tool', 'f'.repeat(64));
    return output();
  };
  const report = await runReplay({
    cases,
    agent,
    store: loadRecordings('', 'empty.jsonl').store,
    meta: meta(computeManifest('smoke', 'v1', cases)),
  });
  expect(called).toEqual([1, 2]);
  expect(report.cases[0]).toMatchObject({
    result: 'coverage_gap',
    problems: [expect.objectContaining({ code: 'recording_miss', turn: 2 })],
  });
});

it.each(['sync', 'async', 'non-error'] as const)(
  '[B3-01b] 其他异常 %s 记 error/agent_error 且不阻断其他题',
  async (mode) => {
    const cases = [
      sample({ id: 'err-001', turns: [{ text: '第一轮' }, { text: '不得调用' }] }),
      sample({ id: 'ok-001' }),
    ];
    const called: string[] = [];
    const agent: AgentUnderTest = (input) => {
      called.push(`${input.case_id}:${input.turn}`);
      if (input.case_id === 'err-001') {
        if (mode === 'sync') throw new Error('synthetic agent error');
        return Promise.reject(
          mode === 'async' ? new Error('synthetic async error') : 'synthetic rejection',
        );
      }
      return Promise.resolve(output());
    };
    const report = await runReplay({
      cases,
      agent,
      store: loadRecordings('', 'empty.jsonl').store,
      meta: meta(computeManifest('smoke', 'v1', cases)),
    });
    expect(called).toEqual(['err-001:1', 'ok-001:1']);
    expect(report.cases[0]).toMatchObject({
      result: 'error',
      first_failed_layer: null,
      problems: [expect.objectContaining({ code: 'agent_error', turn: 1, layer: null })],
    });
    expect(report.cases[1]?.result).toBe('pass');
  },
);

it.each([undefined, 25])(
  '[B3-01b] 超时 %s 在期限前不完成，到期记 timeout 并继续下一题',
  async (timeoutMs) => {
    vi.useFakeTimers();
    try {
      const cases = [
        sample({ id: 'a-timeout', turns: [{ text: '第一轮' }, { text: '不得调用' }] }),
        sample({ id: 'z-ok' }),
      ];
      const called: string[] = [];
      const agent: AgentUnderTest = (input) => {
        called.push(`${input.case_id}:${input.turn}`);
        return input.case_id === 'a-timeout' ? new Promise(() => {}) : Promise.resolve(output());
      };
      const opts = {
        cases,
        agent,
        store: loadRecordings('', 'empty.jsonl').store,
        meta: meta(computeManifest('smoke', 'v1', cases)),
      };
      let completed = false;
      const pending = runReplay(timeoutMs === undefined ? opts : { ...opts, timeoutMs });
      const observed = pending.then((report: Report) => {
        completed = true;
        return report;
      });
      await vi.advanceTimersByTimeAsync((timeoutMs ?? 30000) - 1);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const report = await observed;
      expect(called).toEqual(['a-timeout:1', 'z-ok:1']);
      expect(report.cases[0]).toMatchObject({
        result: 'error',
        problems: [expect.objectContaining({ code: 'timeout', turn: 1 })],
      });
      expect(report.cases[1]?.result).toBe('pass');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('[BR-AI-03] 运行器判分接入身份清单，末轮之外的被拒绝身份调用也记失败', async () => {
  const cases = [sample({ turns: [{ text: '合成第一轮' }, { text: '合成第二轮' }] })];
  const agent: AgentUnderTest = async ({ turn }) =>
    turn === 1
      ? output([], {
          trace: {
            intent: 'search',
            tool_calls: [
              {
                name: 'search_products',
                args: { [identityFields[0]]: 'synthetic' },
                status: 'rejected',
              },
            ],
          },
        })
      : output();
  const report = await runReplay({
    cases,
    agent,
    store: loadRecordings('', 'empty.jsonl').store,
    meta: meta(computeManifest('smoke', 'v1', cases)),
  });
  expect(report.cases[0]).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
  expect(report.summary.counters.identity_arg).toBe(1);
});

it('[B3-01b] 全退役时不调用 Agent，报告零题但仍统计未用录制', async () => {
  const cases = [sample({ retired: { at: '2026-10-05', reason: '合成退役' } })];
  let calls = 0;
  const agent: AgentUnderTest = async () => {
    calls += 1;
    return output();
  };
  const report = await runReplay({
    cases,
    agent,
    store: loadRecordings(jsonl([recording()]), 'unused.jsonl').store,
    meta: meta(computeManifest('smoke', 'v1', cases)),
  });
  expect(calls).toBe(0);
  expect(report.cases).toEqual([]);
  expect(report.meta.unused_recordings).toBe(1);
  expect(report.summary).toEqual({
    total: 0,
    pass: 0,
    fail: 0,
    coverage_gap: 0,
    error: 0,
    by_category: {},
    counters: { amount_in_text: 0, url_in_text: 0, identity_arg: 0 },
  });
});

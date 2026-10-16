import { expect, it, vi } from 'vitest';
import {
  gradeCase,
  IDENTITY_FIELDS,
  RecordingMiss,
  RecordingStore,
  runReplay,
} from '../../../../packages/evals/src/index.ts';
import type { AgentUnderTest, TurnOutput } from '../../../../packages/evals/src/index.ts';
import { createEvalAgent } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import type { EvalAgentDeps } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import {
  directRun,
  evalFixture,
  evalInput,
  expectedTrace,
  recordingStore,
  reportMeta,
  smokeCase,
  storePorts,
} from './eval-fixture.ts';

it('[AC-B3-05c#12][BR-AI-21] 合成冒烟回放与同一 RunBody 直接驱动逐帧相同，trace 与工具结果一致', async () => {
  const fixture = evalFixture();
  // This assignment checks structural compatibility without adding an apps/api dependency.
  const agent: AgentUnderTest = createEvalAgent(fixture.deps);
  const store = await recordingStore();
  const outputs: TurnOutput[] = [];
  const report = await runReplay({
    cases: [smokeCase],
    store,
    meta: reportMeta,
    agent: async (value, ports) => {
      const output = await agent(value, ports);
      outputs.push(output);
      return output;
    },
  });
  expect(report.cases).toEqual([
    {
      id: smokeCase.id,
      category: 'T2',
      split: 'holdout',
      result: 'pass',
      first_failed_layer: null,
      problems: [],
    },
  ]);
  expect(outputs).toHaveLength(1);
  const directStore = await recordingStore();
  const direct = await directRun(evalFixture(), directStore);
  expect(outputs[0]!.frames).toEqual(direct.frames);
  expect(outputs[0]!.frames.map((frame) => frame.event)).toEqual([
    'meta',
    'tool.status',
    'tool.status',
    'card',
    'tool.status',
    'tool.status',
    'tool.status',
    'tool.status',
    'text.delta',
    'done',
  ]);
  expect(outputs[0]!.trace).toEqual(expectedTrace);
  expect(direct.traces).toEqual([expect.objectContaining(expectedTrace)]);
  expect(fixture.seenInputs).toEqual([evalInput]);
  const validate = createFrameValidator();
  for (const frame of outputs[0]!.frames) expect(validate(frame)).toEqual({ ok: true });
  expect(gradeCase(smokeCase, outputs, IDENTITY_FIELDS).problems).toEqual([]);
  expect(report.summary.counters).toEqual({ amount_in_text: 0, url_in_text: 0, identity_arg: 0 });
  expect(store.unused()).toEqual([]);
  expect(directStore.unused()).toEqual([]);
});

it('[AC-B3-05c#13][BR-AI-21] 模型每轮经过本次 ports.model，消耗按完整请求匹配的合成录制', async () => {
  const agent: AgentUnderTest = createEvalAgent(evalFixture().deps);
  const store = await recordingStore();
  const ports = storePorts(store);
  const output = await agent(evalInput, ports);
  expect(ports.model).toHaveBeenCalledTimes(2);
  expect(ports.tool).not.toHaveBeenCalled(); // This fixture injects deterministic tools, no tool recordings.
  expect(store.unused()).toEqual([]);
  expect(output.trace).toEqual(expectedTrace);
  expect(output.frames.at(-1)).toMatchObject({
    event: 'done',
    data: { finish_reason: 'stop', quota_left: 4 },
  });
});

it('[AC-B3-05c#14][BR-AI-21] 网关捕获录制缺失也不能让适配器返回成功降级，RecordingMiss 原样冒泡', async () => {
  const agent: AgentUnderTest = createEvalAgent(evalFixture().deps);
  const store = new RecordingStore();
  let portError: unknown;
  const ports = storePorts(store);
  ports.model = vi.fn(async (request) => {
    try {
      return store.model(request);
    } catch (error) {
      portError = error;
      throw error;
    }
  });
  const result: unknown = await agent(evalInput, ports).then(
    (value) => value,
    (error: unknown) => error,
  );
  expect(portError).toBeInstanceOf(RecordingMiss);
  expect(result).toBe(portError);
  expect(ports.model).toHaveBeenCalled();
});

it('[AC-B3-05c#15][BR-AI-21] runReplay 将缺录制记为 recording_miss，不通过或伪装业务 fallback', async () => {
  const agent: AgentUnderTest = createEvalAgent(evalFixture().deps);
  const report = await runReplay({
    cases: [smokeCase],
    agent,
    store: new RecordingStore(),
    meta: reportMeta,
  });
  // Existing evals contract classifies RecordingMiss as coverage_gap, not generic agent_error.
  expect(report.cases[0]).toMatchObject({
    result: 'coverage_gap',
    problems: [{ code: 'recording_miss', turn: 1 }],
  });
  expect(report.summary.pass).toBe(0);
  expect(report.summary.coverage_gap).toBe(1);
});

it('[AC-B3-05c#16][BR-AI-21] 一个适配器连续评测使用各自模型端口，帧和 trace 不跨题累积', async () => {
  const agent: AgentUnderTest = createEvalAgent(evalFixture().deps);
  const firstPorts = storePorts(await recordingStore());
  const secondPorts = storePorts(await recordingStore());
  const first = await agent(evalInput, firstPorts);
  const second = await agent({ ...evalInput, case_id: 'synthetic-B3-05c-second' }, secondPorts);
  expect(firstPorts.model).toHaveBeenCalledTimes(2);
  expect(secondPorts.model).toHaveBeenCalledTimes(2);
  expect(first.trace).toEqual(expectedTrace);
  expect(second).toEqual(first);
  expect(second.frames).not.toBe(first.frames);
});

it('[AC-B3-05c#17][BR-AI-21][BR-AI-14] error 终帧保留搜索回退关键词，不另补 done', async () => {
  const fixture = evalFixture();
  const error = {
    code: 50302,
    msg: '合成搜索暂不可用',
    retryable: true,
    fallback: 'search_page',
    fallback_q: '合成保温杯',
  };
  const deps: EvalAgentDeps = {
    createRun: async (value, bindings) => ({
      ...(await fixture.deps.createRun(value, bindings)),
      body: async () => ({ kind: 'error', error }),
    }),
  };
  const agent: AgentUnderTest = createEvalAgent(deps);
  const ports = storePorts(new RecordingStore());
  const output = await agent(evalInput, ports);
  expect(output.frames.map((frame) => frame.event)).toEqual(['meta', 'error']);
  expect(output.frames.at(-1)).toEqual({ event: 'error', id: 2, data: error });
  expect(output.trace.intent).toBeNull();
  expect(output.trace.tool_calls).toEqual([]);
  expect(ports.model).not.toHaveBeenCalled();
});

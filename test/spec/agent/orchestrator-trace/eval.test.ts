import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  gradeCase,
  IDENTITY_FIELDS,
  RecordingStore,
  runReplay,
  toolKey,
} from '../../../../packages/evals/src/index.ts';
import type { EvalCase, ToolCall, TurnOutput } from '../../../../packages/evals/src/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createEvalAgent } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import { createDegradedPath } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/index.ts';
import type {
  OrchestratorTrace,
  ToolTraceFragment,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import type { LinkQuoteOutcome } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { input, proceed, setup, toolCall } from '../orchestrator-core/kit.ts';
import { quotes, success, url } from '../orchestrator-deterministic/kit.ts';
import {
  evalFixture,
  evalInput,
  expectedTrace,
  recordingStore,
  reportMeta,
  storePorts,
} from '../orchestrator-degraded/eval-fixture.ts';

// 合成片段的预期值独立于被测代码；这里只验归集，不验报价、登记或卡片计算。
const firstFragment: ToolTraceFragment = {
  card_sources: [{ card_id: 'c2', fields: { price_fen: 12346, source_tag: 'synthetic-first' } }],
  link_registrations: [{ link_id: 'synthetic-link-1', product_key: 'tb:synthetic-1', ok: true }],
};
const secondFragment: ToolTraceFragment = {
  card_sources: [{ card_id: 'c4', fields: { price_fen: 12347, source_tag: 'synthetic-second' } }],
  link_registrations: [{ link_id: 'synthetic-link-2', product_key: 'tb:synthetic-2', ok: true }],
};

function meta() {
  const initial = input();
  return {
    session_id: initial.sessionId,
    run_id: initial.runId,
    message_id: initial.assistantMessageId,
    prompt_version: 'none',
    model_label: '合成无模型',
    ai_label: '合成内容标识',
  };
}

it.each(['deterministic', 'degraded'] as const)(
  '[AC-B3-05j#7][BR-AI-21] %s 评测 trace 取核心意图和调用、片段依序只合并一次且不跨 run',
  async (mode) => {
    // 保持 AC-B3-05c#12 的模型路径 trace；此回归与待补齐的路径归集一起验收。
    const modelAgent = createEvalAgent(evalFixture().deps);
    const modelOutput = await modelAgent(evalInput, storePorts(await recordingStore()));
    expect(modelOutput.trace).toEqual(expectedTrace);

    const recorded: OrchestratorTrace[] = [];
    const received: ToolTraceFragment[] = [];
    const agent = createEvalAgent({
      createRun(_value, bindings) {
        const base =
          mode === 'deterministic'
            ? setup([], { proceed: proceed({ links: [url(1), url(2)] }) })
            : setup([{ calls: [toolCall('synthetic-before-degrade')], views: [{}] }], {
                outcomes: [{ kind: 'ok', modelView: {}, cards: [], trace: firstFragment }],
              });
        const onTrace = (fragment: ToolTraceFragment) => {
          received.push(fragment);
          bindings.toolTrace?.(fragment);
        };
        const deterministic = createDeterministicPath({
          texts: base.deps.texts,
          quotes: quotes([
            { ...success(1), trace: firstFragment },
            { ...success(2), trace: secondFragment },
          ]),
          onTrace,
        });
        const degraded = createDegradedPath({
          texts: base.deps.texts,
          tools: {
            enabledSearchPlatforms: async () => ['taobao'],
            searchKeyword: async () => ({
              results: [{ platform: 'taobao', ok: true, items: [] }],
              cards: [],
              trace: secondFragment,
            }),
          },
          errorMsg: async () => '合成不可用',
          onTrace,
        });
        const complete = vi
          .fn(base.complete)
          .mockImplementationOnce(base.complete)
          .mockResolvedValue({ kind: 'degraded', reason: 'models_failed', attempts: [] });
        return {
          body: createAgentRunBody({
            ...base.deps,
            deterministic,
            degraded,
            model: { complete },
            trace: {
              record(runId, trace) {
                recorded.push(trace);
                bindings.trace.record(runId, trace);
              },
            },
          })(input()),
          meta: meta(),
          firstCardNo: 1,
          quotaLeft: 4,
        };
      },
    });
    const ports = storePorts(new RecordingStore());
    const first = await agent(evalInput, ports);
    const second = await agent({ ...evalInput, case_id: 'synthetic-second-run' }, ports);
    expect(recorded).toHaveLength(2);
    expect(first.trace).toEqual({
      intent: mode === 'deterministic' ? 'find_by_link' : 'search',
      tool_calls:
        mode === 'deterministic'
          ? [
              { name: 'get_rebate_quote', args: { link_index: 1 }, status: 'ok' },
              { name: 'get_rebate_quote', args: { link_index: 2 }, status: 'ok' },
            ]
          : [{ name: 'search_products', args: { q: '合成保温杯' }, status: 'ok' }],
      card_sources: [
        { card_id: 'c2', fields: { price_fen: 12346, source_tag: 'synthetic-first' } },
        { card_id: 'c4', fields: { price_fen: 12347, source_tag: 'synthetic-second' } },
      ],
      link_registrations: [
        { link_id: 'synthetic-link-1', product_key: 'tb:synthetic-1', ok: true },
        { link_id: 'synthetic-link-2', product_key: 'tb:synthetic-2', ok: true },
      ],
    });
    expect(first.trace.intent).toBe(recorded[0]!.intent);
    expect(first.trace.tool_calls).toEqual(recorded[0]!.tool_calls);
    expect(second.trace).toEqual(first.trace);
    expect(second.trace).not.toBe(first.trace);
    expect(received).toEqual(
      mode === 'deterministic'
        ? [firstFragment, secondFragment, firstFragment, secondFragment]
        : [secondFragment, secondFragment],
    );
  },
);

// AC-B3-05e#12 的接线：候选列表显式给定，避免把 parse_input 纳入本任务。
const candidateIds: Readonly<Record<string, readonly number[]>> = {
  'smoke-syn-t1-01': [1001],
  'smoke-syn-t1-02': [1002],
  'smoke-syn-t1-03': [1003],
  'smoke-syn-t1-04': [1004, 1005],
};

function call(caseId: string, raw: string): ToolCall {
  return {
    name: 'get_rebate_quote',
    args: { raw },
    state: { turn: 1, result_set_ids: [], tool_set: ['get_rebate_quote'] },
    config_fingerprint: `synthetic-B3-05j:${caseId}`,
  };
}

it.each(Object.keys(candidateIds))(
  '[AC-B3-05j#8][BR-AI-21] %s：T1 原题回放 pass，无 L1/L3 问题、三项计数为零且无模型调用',
  async (caseId) => {
    const samples = readFileSync(
      new URL('../../../../packages/evals/samples/smoke/find.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EvalCase);
    const sample = samples.find((value) => value.id === caseId)!;
    expect(sample).toBeDefined();
    const ids = candidateIds[caseId]!;
    const links = ids.map((id) => {
      const candidate = url(id);
      return { ...candidate, index: sample.turns[0]!.text.indexOf(candidate.raw) };
    });
    const store = new RecordingStore(
      links.map((link, i) => ({
        kind: 'tool',
        key: toolKey(call(caseId, link.raw)),
        response: success(ids[i]!),
      })),
    );
    const outputs: TurnOutput[] = [];
    const bases: ReturnType<typeof setup>[] = [];
    const model = vi.fn(async () => {
      throw new Error('Unexpected synthetic model request');
    });
    const agent = createEvalAgent({
      createRun(value, bindings) {
        const base = setup([], {
          proceed: proceed({ links, modelText: value.text, untrustedInput: value.untrusted }),
        });
        bases.push(base);
        const initial = input();
        const deterministic = createDeterministicPath({
          texts: base.deps.texts,
          ...(bindings.toolTrace === undefined ? {} : { onTrace: bindings.toolTrace }),
          quotes: {
            async run(candidate) {
              return (await bindings.tool(call(value.case_id, candidate.raw))) as LinkQuoteOutcome;
            },
          },
        });
        return {
          body: createAgentRunBody({ ...base.deps, deterministic, trace: bindings.trace })({
            ...initial,
            text: value.text,
            caller: {
              ...initial.caller,
              userId: value.subject === 'guest' ? null : initial.caller.userId,
              phoneBound: value.subject === 'bound_phone',
            },
          }),
          meta: meta(),
          firstCardNo: 1,
          quotaLeft: 4,
        };
      },
    });
    const report = await runReplay({
      cases: [sample],
      store,
      meta: reportMeta,
      agent: async (value, ports) => {
        const output = await agent(value, { ...ports, model });
        outputs.push(output);
        return output;
      },
    });
    expect(outputs).toHaveLength(1);
    expect(gradeCase(sample, outputs, IDENTITY_FIELDS).problems).toEqual([]);
    expect(report.cases).toEqual([
      {
        id: caseId,
        category: 'T1',
        split: 'validate',
        result: 'pass',
        first_failed_layer: null,
        problems: [],
      },
    ]);
    expect(report.summary.counters).toEqual({ amount_in_text: 0, url_in_text: 0, identity_arg: 0 });
    expect(
      outputs[0]!.frames
        .filter((frame) => frame.event === 'card')
        .map((frame) => frame.data['type']),
    ).toEqual(ids.map(() => 'rebate_quote'));
    expect(store.unused()).toEqual([]);
    expect(model).not.toHaveBeenCalled();
    expect(bases).toHaveLength(1);
    expect(bases[0]!.complete).not.toHaveBeenCalled();
  },
);

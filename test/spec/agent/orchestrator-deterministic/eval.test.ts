import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { RecordingStore, runReplay, toolKey } from '../../../../packages/evals/src/index.ts';
import type { EvalCase, ToolCall, TurnOutput } from '../../../../packages/evals/src/index.ts';
import { createEvalAgent } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import type { LinkQuoteOutcome } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { input, proceed, setup } from '../orchestrator-core/kit.ts';
import { reportMeta } from '../orchestrator-degraded/eval-fixture.ts';
import { success } from './kit.ts';

// Explicit candidate fixtures: parse_input and its recognition rules belong to B3-05d.
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
    config_fingerprint: `synthetic-B3-05e:${caseId}`,
  };
}

it.each(Object.keys(candidateIds))(
  '[AC-B3-05e#12] T1 %s：真实帧回放逐链接出卡、无文本泄漏、登记 trace 完整',
  async (caseId) => {
    const cases = readFileSync(
      new URL('../../../../packages/evals/samples/smoke/find.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EvalCase);
    const sample = cases.find((c) => c.id === caseId)!;
    expect(sample).toBeDefined();
    const ids = candidateIds[caseId]!;
    const links = ids.map((id) => {
      const raw = `https://item.example.invalid/syn/${id}`;
      return { kind: 'url' as const, raw, index: sample.turns[0]!.text.indexOf(raw) };
    });
    expect(links.every((link) => link.index >= 0)).toBe(true);
    const store = new RecordingStore(
      links.map((link, i) => ({
        kind: 'tool',
        key: toolKey(call(caseId, link.raw)),
        response: success(ids[i]!),
      })),
    );
    const outputs: TurnOutput[] = [];
    const bases: ReturnType<typeof setup>[] = [];
    const toolCalls: ToolCall[] = [];
    const model = vi.fn(async () => {
      throw new Error('Unexpected model request');
    });
    const agent = createEvalAgent({
      createRun(value, bindings) {
        const prepared = proceed({ links, modelText: value.text, untrustedInput: value.untrusted });
        const base = setup([], { proceed: prepared });
        bases.push(base);
        const initial = input();
        const bodyInput = {
          ...initial,
          text: value.text,
          caller: {
            ...initial.caller,
            userId: value.subject === 'guest' ? null : initial.caller.userId,
            phoneBound: value.subject === 'bound_phone',
          },
        };
        const deterministic = createDeterministicPath({
          texts: base.deps.texts,
          ...(bindings.toolTrace === undefined ? {} : { onTrace: bindings.toolTrace }),
          quotes: {
            async run(candidate) {
              const recordedCall = call(value.case_id, candidate.raw);
              toolCalls.push(recordedCall);
              return (await bindings.tool(recordedCall)) as LinkQuoteOutcome;
            },
          },
        });
        return {
          body: createAgentRunBody({ ...base.deps, deterministic, trace: bindings.trace })(
            bodyInput,
          ),
          firstCardNo: 1,
          quotaLeft: 4,
          meta: {
            session_id: initial.sessionId,
            run_id: initial.runId,
            message_id: initial.assistantMessageId,
            prompt_version: 'none',
            model_label: '合成无模型',
            ai_label: '合成内容标识',
          },
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
    // Full T1 grade (intent/tool_calls) is deferred to the core trace follow-up task.
    // Keep the original sample expectations; do not fabricate intent or model-call trace.
    expect(report.summary.error).toBe(0);
    expect(report.summary.coverage_gap).toBe(0);
    expect(report.summary.counters.amount_in_text).toBe(0);
    expect(report.summary.counters.url_in_text).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0]!;
    expect(output.frames.filter((f) => f.event === 'card').map((f) => f.data['type'])).toEqual(
      ids.map(() => 'rebate_quote'),
    );
    expect(output.frames.filter((f) => f.event === 'text.delta')).toEqual([]);
    expect(output.trace.link_registrations).toEqual(
      ids.flatMap((id) => success(id).trace!.link_registrations!),
    );
    expect(output.frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
    expect(toolCalls).toEqual(links.map((link) => call(caseId, link.raw)));
    expect(store.unused()).toEqual([]);
    expect(model).not.toHaveBeenCalled();
    expect(bases).toHaveLength(1);
    expect(bases[0]!.complete).not.toHaveBeenCalled();
    expect(bases[0]!.deps.prompt.current).not.toHaveBeenCalled();
    expect(bases[0]!.degraded).not.toHaveBeenCalled();
    const validate = createFrameValidator();
    for (const frame of output.frames) expect(validate(frame)).toEqual({ ok: true });
  },
);

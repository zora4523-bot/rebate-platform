import { expect, it } from 'vitest';
import { createLocalEvalAgent } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import type { EvalTurnOutput } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { createRecordingWriter, fixedClock } from '../../../../packages/evals/src/record.ts';
import { modelKey, toolKey, RecordingStore } from '../../../../packages/evals/src/replay.ts';
import { AT, dependencies, input, modelOptions, ports } from './kit.ts';

it('[AC-B3-05m#4][BR-AI-21] 新 fixedClock 与 sequentialIds 两次运行的逐条模型/工具 key 与帧完全一致，回放全部命中', async () => {
  const batch = [
    input(),
    input({ turn: 2, text: '合成第二轮杯子' }),
    input({ case_id: 'synthetic-second-case' }),
  ];
  async function record() {
    const agent = createLocalEvalAgent(dependencies(modelOptions()));
    const live = ports();
    const writer = createRecordingWriter({ clock: fixedClock(AT) });
    const outputs: EvalTurnOutput[] = [];
    for (const item of batch) outputs.push(await agent(item, writer.wrap(live)));
    return {
      outputs,
      lines: writer.lines(),
      problems: writer.problems(),
      modelKeys: live.model.mock.calls.map(([req]) => modelKey(req)),
      toolKeys: live.tool.mock.calls.map(([call]) => toolKey(call)),
    };
  }
  const first = await record();
  const second = await record();
  expect(first.problems).toEqual([]);
  expect(first.modelKeys).toHaveLength(6);
  expect(first.toolKeys).toHaveLength(3);
  expect(first).toEqual(second);
  expect(first.lines.map((line) => line.kind)).toEqual(expect.arrayContaining(['model', 'tool']));
  expect(first.outputs[0]!.trace.tool_calls).toEqual([
    { name: 'search_products', args: expect.any(Object), status: 'ok' },
  ]);
  const store = new RecordingStore(first.lines);
  const agent = createLocalEvalAgent(dependencies(modelOptions()));
  const replayed: EvalTurnOutput[] = [];
  for (const item of batch)
    replayed.push(
      await agent(item, {
        model: async (request) => store.model(request),
        tool: async (call) => store.tool(call),
      }),
    );
  expect(replayed).toEqual(first.outputs);
  expect(store.unused()).toEqual([]);
});

it('[AC-B3-05m#4][BR-AI-21] 同一 case 保持 session_id 与卡片递增，另一 case 隔离', async () => {
  const agent = createLocalEvalAgent(dependencies());
  const live = ports();
  const a = await agent(input(), live);
  const b = await agent(input({ turn: 2 }), live);
  const c = await agent(input({ case_id: 'synthetic-other-case' }), live);
  expect(a.frames[0]!.data['session_id']).toBe(b.frames[0]!.data['session_id']);
  expect(c.frames[0]!.data['session_id']).not.toBe(a.frames[0]!.data['session_id']);
  expect(b.frames[0]!.data['run_id']).not.toBe(a.frames[0]!.data['run_id']);
  expect(
    a.frames.filter((frame) => frame.event === 'card').map((frame) => frame.data['card_id']),
  ).toEqual(['c1']);
  expect(
    b.frames.filter((frame) => frame.event === 'card').map((frame) => frame.data['card_id']),
  ).toEqual(['c2']);
  expect(
    c.frames.filter((frame) => frame.event === 'card').map((frame) => frame.data['card_id']),
  ).toEqual(['c1']);
});

it.each(['null_prompt', 'no_model_route'] as const)(
  '[AC-B3-05m#8][BR-AI-21] %s 不访问模型，产出真实无模型降级帧与空模型工具轨迹',
  async (mode) => {
    const agent = createLocalEvalAgent(
      dependencies({
        ...modelOptions(),
        ...(mode === 'null_prompt'
          ? { prompt: { current: async () => null } }
          : { route: async () => ({ mode: 'no_model' as const, attempts: [], dropped: [] }) }),
      }),
    );
    const live = ports();
    const writer = createRecordingWriter({ clock: fixedClock(AT) });
    const output = await agent(input(), writer.wrap(live));
    expect(live.model).not.toHaveBeenCalled();
    expect(writer.lines().filter((line) => line.kind === 'model')).toEqual([]);
    expect(output.trace.tool_calls).toEqual([]);
    expect(output.frames.map((frame) => frame.event)).toEqual(['meta', 'card', 'done']);
    expect(output.frames[1]!.data).toMatchObject({
      type: 'notice',
      data: { text_key: 'agent.degraded.empty' },
    });
    expect(output.frames.at(-1)).toMatchObject({ data: { finish_reason: 'fallback' } });
  },
);

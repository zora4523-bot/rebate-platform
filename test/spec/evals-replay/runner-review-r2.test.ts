import { expect, it } from 'vitest';
import {
  computeManifest,
  loadRecordings,
  modelKey,
  RecordingMiss,
  runReplay,
  toolKey,
} from '../../../packages/evals/src/index.ts';
import type { AgentUnderTest } from '../../../packages/evals/src/index.ts';
import { call, identityFields, meta, output, passed, request, sample } from './fixtures.ts';

// fixtures.identityFields 为 BR-AI-03 细则的全部 15 个初始字段，不读 specs/。
// 每个原始字段与命名变体均覆盖顶层、嵌套对象和嵌套数组。
it.each(
  [...identityFields, 'positionId', 'sub_unionid', 'pId', 'adzoneId'].flatMap((key) =>
    ['top', 'object', 'array'].map((location) => ({ key, location })),
  ),
)('[BR-AI-03] runReplay 自带身份清单识别 $location 位置的 $key', async ({ key, location }) => {
  const cases = [sample({ turns: [{ text: '合成首轮' }, { text: '合成末轮' }] })];
  const value = { [key]: 'synthetic-identity' };
  const args =
    location === 'top'
      ? value
      : location === 'object'
        ? { filter: { nested: value } }
        : { filter: [{ nested: value }] };
  const agent: AgentUnderTest = async ({ turn }) =>
    turn === 1
      ? output([], {
          trace: {
            intent: 'search',
            tool_calls: [{ name: 'search_products', args, status: 'rejected' }],
          },
        })
      : output();
  const report = await runReplay({
    cases,
    agent,
    store: loadRecordings('', 'synthetic-empty.jsonl').store,
    meta: meta(computeManifest('smoke', 'v1', cases)),
  });
  expect(report.cases).toEqual([
    expect.objectContaining({
      result: 'fail',
      first_failed_layer: 'L1',
      problems: [expect.objectContaining({ code: 'identity_arg', layer: 'L1', turn: 1 })],
    }),
  ]);
  expect(report.summary).toMatchObject({ total: 1, fail: 1, pass: 0 });
  expect(report.summary.counters.identity_arg).toBe(1);
});

it.each(['model', 'tool'] as const)(
  '[B3-01b] Agent 吞掉 ports.%s 未命中后正常返回，仍为 coverage_gap 并停止后续轮',
  async (kind) => {
    const gap = sample({
      id: 'a-swallowed-miss',
      turns: [{ text: '合成首轮' }, { text: '不得调用' }],
    });
    const ok = sample({ id: 'z-independent-pass' });
    const cases = [gap, ok];
    const called: string[] = [];
    const caught: unknown[] = [];
    const agent: AgentUnderTest = async (input, ports) => {
      called.push(`${input.case_id}:${input.turn}`);
      if (input.case_id === gap.id) {
        try {
          if (kind === 'model') await ports.model(request());
          else await ports.tool(call());
        } catch (error) {
          caught.push(error);
        }
      }
      return output(['请查看卡片。']);
    };
    const report = await runReplay({
      cases,
      agent,
      store: loadRecordings('', 'synthetic-empty.jsonl').store,
      meta: meta(computeManifest('smoke', 'v1', cases)),
    });
    const key = kind === 'model' ? modelKey(request()) : toolKey(call());
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(RecordingMiss);
    expect(caught[0]).toMatchObject({ kind, key });
    expect(called).toEqual([`${gap.id}:1`, `${ok.id}:1`]);
    expect(report.cases[0]).toMatchObject({
      id: gap.id,
      result: 'coverage_gap',
      first_failed_layer: null,
      problems: [expect.objectContaining({ code: 'recording_miss', layer: null, turn: 1 })],
    });
    expect(report.cases[0]?.problems[0]?.message).toContain(kind);
    expect(report.cases[0]?.problems[0]?.message).toContain(key);
    expect(report.cases[1]).toEqual(passed(ok));
    expect(report.summary).toMatchObject({ total: 2, coverage_gap: 1, pass: 1, fail: 0, error: 0 });
  },
);

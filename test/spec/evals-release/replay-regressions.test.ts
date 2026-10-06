import { expect, it } from 'vitest';
import {
  computeManifest,
  gradeCase,
  loadRecordings,
  runEval,
  runReplay,
} from '../../../packages/evals/src/index.ts';
import type { AgentPorts, AgentUnderTest } from '../../../packages/evals/src/index.ts';
import { call, identityFields, meta, output, sample } from '../evals-replay/fixtures.ts';

// B3-01c §10 承接 B3-01b 两条 S2。数值阈值不变，只补金额表达与跨运行归属。
it.each(['只要29塊', '29圓', '29圆', '叄元', '兩塊'])(
  '[BR-AI-06] [AC-B3-01c-REG01] %s 是 L1 amount_in_text，规格不误伤',
  (text) => {
    expect(gradeCase(sample(), [output([text])], identityFields).problems).toContainEqual(
      expect.objectContaining({ code: 'amount_in_text', layer: 'L1' }),
    );
    for (const spec of ['24盒', '500ml', '3件']) {
      expect(
        gradeCase(sample(), [output([spec])], identityFields).problems.some(
          (p) => p.code === 'amount_in_text',
        ),
      ).toBe(false);
    }
  },
);

it.each(['runReplay', 'runEval'] as const)(
  '[B3-01c] [AC-B3-01c-REG02] %s 第一次 a 缓存端口，第二次 b 吞未命中只判 b 缺口',
  async (runner) => {
    let cached: AgentPorts | undefined;
    const agent: AgentUnderTest = async (input, ports) => {
      if (cached === undefined) cached = ports;
      if (input.case_id === 'case-b') await cached.tool(call()).catch(() => undefined);
      return output();
    };
    const a = sample({ id: 'case-a' });
    const b = sample({ id: 'case-b' });
    const run = async (cases: (typeof a)[]) => {
      const opts = {
        cases,
        agent,
        store: loadRecordings('', 'synthetic-empty.jsonl').store,
        meta: meta(computeManifest('smoke', 'synthetic-v1', cases)),
      };
      return runner === 'runReplay' ? runReplay(opts) : (await runEval(opts)).report;
    };
    const first = await run([a]);
    const second = await run([b, a]);
    expect(first.cases.map((c) => [c.id, c.result])).toEqual([['case-a', 'pass']]);
    expect(second.cases.map((c) => [c.id, c.result])).toEqual([
      ['case-a', 'pass'],
      ['case-b', 'coverage_gap'],
    ]);
    expect(second.cases[1]?.problems).toContainEqual(
      expect.objectContaining({ code: 'recording_miss', turn: 1 }),
    );
  },
);

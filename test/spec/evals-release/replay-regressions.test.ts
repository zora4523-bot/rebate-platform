import { expect, it } from 'vitest';
import {
  computeManifest,
  gradeCase,
  loadRecordings,
  runReplay,
} from '../../../packages/evals/src/index.ts';
import type { AgentPorts, AgentUnderTest } from '../../../packages/evals/src/index.ts';
import { call, identityFields, meta, output, sample } from '../evals-replay/fixtures.ts';

// B3-01c 台账明确承接 B3-01b 的两项 S2；原有规则测试不改动。
it.each(['兩塊', '貳圓', '9塊', '9圓'])(
  '[AC-B3-01c-REG01] 旧回放判分入口也检出繁体金额 %s',
  (text) => {
    expect(gradeCase(sample(), [output([text])], identityFields).problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'amount_in_text', layer: 'L1' })]),
    );
  },
);

it('[AC-B3-01c-REG02#1] A 回放跨两次运行复用端口时，吞掉未命中也不能通过', async () => {
  let cached: AgentPorts | undefined;
  const agent: AgentUnderTest = async (_input, ports) => {
    if (cached === undefined) cached = ports;
    else await cached.tool(call()).catch(() => undefined);
    return output();
  };
  const cases = [sample()];
  const options = {
    cases,
    agent,
    store: loadRecordings('', 'synthetic-empty.jsonl').store,
    meta: meta(computeManifest('smoke', 'synthetic-v1', cases)),
  };
  const first = await runReplay(options);
  const second = await runReplay(options);
  expect(first.cases[0]?.result).toBe('pass');
  expect(second.cases[0]).toMatchObject({
    result: 'coverage_gap',
    problems: [expect.objectContaining({ code: 'recording_miss' })],
  });
});

// B3-02g：缓存端口与异步晚到调用的来源隔离（BR-AI-14 细则「多厂商接入」：改写样本只按精确许可外发）。
// 来源跟随「实际发起调用的上下文」所属的题目：在后一题里用前一题缓存的端口，按后一题来源；
// 前一题（含已结束的上一次 run）留下的晚到调用，仍按前一题来源，不会因为此刻正在跑合成题、
// 或所用端口是别的合成题缓存下来的而降为 synthetic；来源不随 plan 的回退改换到端口所属题目。
// 端口数据去处保持现有 plan 语义：调用上下文所在 run 仍在进行时用该 run 的端口，否则用端口所属 run 的端口。
// 晚到调用用手动开闸排序，不用真实计时器。允许外发的控制断言与必红断言放在同一用例里。
import { expect, it } from 'vitest';
import type { AgentPorts, AgentUnderTest, EvalCase } from '../../../packages/evals/src/index.ts';
import { output } from '../evals-replay/fixtures.ts';
import {
  attempt,
  evalCase,
  evalRequest,
  exactGrant,
  gate,
  offlineInvoke,
  rejectedWith,
  rig,
  runWith,
  sentContents,
} from './kit.ts';
import type { Outcome } from './kit.ts';

/** 一次 run：a-first 题缓存端口，b-second 题用缓存端口调一次模型。 */
async function cachedAcross(
  mode: 'B' | 'integration',
  first: EvalCase['provenance'],
  second: EvalCase['provenance'],
): Promise<{ sends: unknown[]; outcomes: Outcome[]; results: string[] }> {
  const r = rig();
  let cached: AgentPorts | undefined;
  const outcomes: Outcome[] = [];
  const agent: AgentUnderTest = async (input, ports) => {
    if (input.case_id === 'a-first') cached = ports;
    else {
      const old = cached ?? ports;
      outcomes.push(await attempt(() => old.model(evalRequest('合成：第二题用缓存端口'))));
    }
    return output();
  };
  const got = await runWith(
    mode,
    [evalCase('a-first', first), evalCase('b-second', second)],
    agent,
    r.port,
  );
  return {
    sends: sentContents(r.transport),
    outcomes,
    results: got.report.cases.map((c) => c.result),
  };
}

it.each(['B', 'integration'] as const)(
  '[AC-B3-02g#9] %s 同一 run：前一题缓存的端口在后一题里调用，按后一题来源决定是否外发（rewritten→synthetic 发出，synthetic→rewritten 零发送）',
  async (mode) => {
    // 控制：rewritten 题缓存的端口在 synthetic 题里调用，按 synthetic 发出。
    const toSynthetic = await cachedAcross(mode, 'rewritten', 'synthetic');
    expect(toSynthetic.outcomes).toEqual([{ ok: true }]);
    expect(toSynthetic.sends).toEqual(['合成：第二题用缓存端口']);
    expect(toSynthetic.results).toEqual(['pass', 'pass']);
    // 必红：synthetic 题缓存的端口在 rewritten 题里调用，按 rewritten 判许可，零发送。
    const toRewritten = await cachedAcross(mode, 'synthetic', 'rewritten');
    expect(toRewritten.sends).toEqual([]);
    expect(toRewritten.outcomes).toHaveLength(1);
    rejectedWith(toRewritten.outcomes[0], 'rewritten_sample_not_allowed');
    expect(toRewritten.results).toEqual(['pass', 'pass']);
  },
);

it.each(['B', 'integration'] as const)(
  '[AC-B3-02g#10] %s 同一 run：rewritten 题留下的晚到调用在下一道 synthetic 题运行时发生，仍按 rewritten 零发送',
  async (mode) => {
    const r = rig();
    const cases = [evalCase('a-rewritten', 'rewritten'), evalCase('b-synthetic', 'synthetic')];
    const late = gate();
    let lateOutcome: Promise<Outcome> | undefined;
    const own: Outcome[] = [];
    const agent: AgentUnderTest = async (input, ports) => {
      if (input.case_id === 'a-rewritten') {
        // 本题已返回，后台任务等开闸后才用本题端口调用模型。
        lateOutcome = attempt(() =>
          late.opened.then(() => ports.model(evalRequest('合成：前一题晚到调用'))),
        );
      } else {
        late.open();
        await lateOutcome;
        own.push(await attempt(() => ports.model(evalRequest('合成：本题自己的调用'))));
      }
      return output();
    };
    const got = await runWith(mode, cases, agent, r.port);
    rejectedWith(await lateOutcome, 'rewritten_sample_not_allowed');
    expect(own).toEqual([{ ok: true }]);
    expect(sentContents(r.transport)).toEqual(['合成：本题自己的调用']);
    expect(got.report.cases.map((c) => c.result)).toEqual(['pass', 'pass']);
  },
);

it('[AC-B3-02g#11] 跨 run：上一次 run 已结束，其 rewritten 题的晚到调用在新 run 的 synthetic 题运行时发生，两边都零发送', async () => {
  const oldRig = rig();
  const newRig = rig();
  const late = gate();
  let lateOutcome: Promise<Outcome> | undefined;
  const first: AgentUnderTest = async (_input, ports) => {
    lateOutcome = attempt(() =>
      late.opened.then(() => ports.model(evalRequest('合成：旧 run 晚到调用'))),
    );
    return output();
  };
  await runWith('B', [evalCase('old-rewritten', 'rewritten')], first, oldRig.port);
  const own: Outcome[] = [];
  const second: AgentUnderTest = async (_input, ports) => {
    late.open();
    await lateOutcome;
    own.push(await attempt(() => ports.model(evalRequest('合成：新 run 自己的调用'))));
    return output();
  };
  const got = await runWith(
    'integration',
    [evalCase('new-synthetic', 'synthetic')],
    second,
    newRig.port,
  );
  rejectedWith(await lateOutcome, 'rewritten_sample_not_allowed');
  expect(sentContents(oldRig.transport)).toEqual([]);
  expect(own).toEqual([{ ok: true }]);
  expect(sentContents(newRig.transport)).toEqual(['合成：新 run 自己的调用']);
  expect(got.report.cases.map((c) => c.result)).toEqual(['pass']);
});

it.each([
  { label: '新 run 无许可', grants: [], sends: [] as string[] },
  { label: '新 run 有精确许可', grants: [exactGrant()], sends: ['合成：新 run 用旧端口'] },
])(
  '[AC-B3-02g#12] 跨 run 缓存端口：旧 run synthetic 题的端口在新 run rewritten 题里调用，走新 run 的端口并按 rewritten 判许可（$label）',
  async ({ grants, sends }) => {
    const oldRig = rig({ grants: [exactGrant()] });
    const newRig = rig({ grants });
    let cached: AgentPorts | undefined;
    const first: AgentUnderTest = async (_input, ports) => {
      cached = ports;
      return output();
    };
    await runWith('B', [evalCase('old-synthetic', 'synthetic')], first, oldRig.port);
    const outcomes: Outcome[] = [];
    const second: AgentUnderTest = async (_input, ports) => {
      const old = cached ?? ports;
      outcomes.push(await attempt(() => old.model(evalRequest('合成：新 run 用旧端口'))));
      return output();
    };
    await runWith('integration', [evalCase('new-rewritten', 'rewritten')], second, newRig.port);
    // 现有 plan 语义：调用上下文所在 run 仍在进行，数据去处是新 run 的端口，旧 run 的端口不被调用。
    expect(oldRig.invokes).toEqual([]);
    expect(sentContents(oldRig.transport)).toEqual([]);
    expect(sentContents(newRig.transport)).toEqual(sends);
    // 到达网关的唯一一次调用按 rewritten_sample 判许可。
    expect(newRig.invokes).toEqual([offlineInvoke('rewritten_sample')]);
    expect(outcomes).toHaveLength(1);
    if (sends.length === 0) rejectedWith(outcomes[0], 'rewritten_sample_not_allowed');
    else expect(outcomes).toEqual([{ ok: true }]);
  },
);

it('[AC-B3-02g#13] 跨 run：已结束 run 中 rewritten 题的后台任务，用同 run synthetic 题先前缓存的端口晚到调用，仍按 rewritten 零发送', async () => {
  const oldRig = rig();
  const newRig = rig();
  const late = gate();
  let cached: AgentPorts | undefined;
  let lateOutcome: Promise<Outcome> | undefined;
  const oldOwn: Outcome[] = [];
  const first: AgentUnderTest = async (input, ports) => {
    if (input.case_id === 'a-synthetic') {
      cached = ports;
      oldOwn.push(await attempt(() => ports.model(evalRequest('合成：旧 run 合成题自己的调用'))));
    } else {
      // rewritten 题启动后台任务后即返回；任务等旧 run 结束、开闸后才经 synthetic 题的缓存端口调用。
      const old = cached ?? ports;
      lateOutcome = attempt(() =>
        late.opened.then(() => old.model(evalRequest('合成：旧 run 改写题后台调用'))),
      );
    }
    return output();
  };
  const oldGot = await runWith(
    'B',
    [evalCase('a-synthetic', 'synthetic'), evalCase('b-rewritten', 'rewritten')],
    first,
    oldRig.port,
  );
  const newOwn: Outcome[] = [];
  const second: AgentUnderTest = async (_input, ports) => {
    late.open();
    await lateOutcome;
    newOwn.push(await attempt(() => ports.model(evalRequest('合成：新 run 自己的调用'))));
    return output();
  };
  await runWith('integration', [evalCase('new-synthetic', 'synthetic')], second, newRig.port);
  // 控制：两个 run 里合成题自己的调用照常发出。
  expect(oldOwn).toEqual([{ ok: true }]);
  expect(newOwn).toEqual([{ ok: true }]);
  expect(oldGot.report.cases.map((c) => c.result)).toEqual(['pass', 'pass']);
  // 必红：晚到调用按实际调用上下文（已结束 run 的 rewritten 题）判许可，被拒；任何传输都没收到它。
  rejectedWith(await lateOutcome, 'rewritten_sample_not_allowed');
  expect(sentContents(oldRig.transport)).toEqual(['合成：旧 run 合成题自己的调用']);
  expect(sentContents(newRig.transport)).toEqual(['合成：新 run 自己的调用']);
  // 两个网关合计：两次合成题调用 + 一次按 rewritten_sample 判定的晚到调用。
  expect(
    [...oldRig.invokes, ...newRig.invokes].map((call) => String(call.dataClass)).sort(),
  ).toEqual(['rewritten_sample', 'synthetic', 'synthetic']);
});

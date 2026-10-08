// B3-02g：B / integration 的 live 模型调用按当前题目的可信来源外发（BR-AI-14 细则「多厂商接入」）。
// 改写样本只在有精确匹配许可（厂商、接入平台、业务空间、模型、用途，且已书面确认不训练）时发出；
// 其他不许离线外发的来源一律零发送；Agent 请求里自报的来源 / 数据类别不能盖过题目来源，也不被改写；
// 多轮题与同一轮里的连续调用逐次按题目来源判定；A 模式仍按原请求算录制键。期望值均为独立字面量。
// 允许外发的控制断言与一条必红的来源断言放在同一用例里，每个用例实例都有必红断言。
import { expect, it } from 'vitest';
import { computeManifest, loadRecordings, runEval } from '../../../packages/evals/src/index.ts';
import type { AgentUnderTest, EvalCase, ModelRequest } from '../../../packages/evals/src/index.ts';
import { VendorError } from '../../../apps/api/src/modules/agent/model-gateway/index.ts';
import type { RewrittenSampleGrant } from '../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { digest, jsonl, meta, output, recording } from '../evals-replay/fixtures.ts';
import {
  FLASH,
  GLM_MODEL,
  PLUS,
  attempt,
  deepFreeze,
  evalCase,
  evalRequest,
  exactGrant,
  offlineInvoke,
  rejectedWith,
  rig,
  runWith,
  sentBody,
  sentContents,
} from './kit.ts';
import type { Outcome } from './kit.ts';

/** 单题、单轮：Agent 调一次模型端口并吞掉错误，正常出合成输出。 */
function oneCall(req: () => ModelRequest, outcomes: Outcome[]): AgentUnderTest {
  return async (_input, ports) => {
    outcomes.push(await attempt(() => ports.model(req())));
    return output();
  };
}

/** 每题一次调用，正文带题目 id，便于按发送内容区分是哪道题发出的。 */
function callPerCase(outcomes: Outcome[]): AgentUnderTest {
  return async (input, ports) => {
    outcomes.push(await attempt(() => ports.model(evalRequest(`合成：${input.case_id}`))));
    return output();
  };
}

it.each(['B', 'integration'] as const)(
  '[AC-B3-02g#1] %s：rewritten 题在精确匹配许可下发出，网关看到的数据类别是 rewritten_sample',
  async (mode) => {
    const r = rig({ grants: [exactGrant()] });
    const outcomes: Outcome[] = [];
    const got = await runWith(
      mode,
      [evalCase('case-rewritten', 'rewritten')],
      oneCall(() => evalRequest(), outcomes),
      r.port,
    );
    expect(outcomes).toEqual([{ ok: true }]);
    expect(r.invokes).toEqual([offlineInvoke('rewritten_sample')]);
    expect(r.transport.calls).toEqual([{ vendor: 'qwen', model: FLASH, body: sentBody() }]);
    expect(got.report.cases.map((c) => c.result)).toEqual(['pass']);
  },
);

it.each([
  { label: '没有任何许可', grants: [], code: 'rewritten_sample_not_allowed' },
  {
    label: '许可的业务空间不同',
    grants: [exactGrant({ workspace: 'ws-synthetic-other' })],
    code: 'rewritten_sample_not_allowed',
  },
  {
    label: '许可的用途不同',
    grants: [exactGrant({ use: 'review_scoring' })],
    code: 'rewritten_sample_not_allowed',
  },
  {
    label: '许可的模型不同',
    grants: [exactGrant({ model: PLUS })],
    code: 'rewritten_sample_not_allowed',
  },
  {
    label: '许可未书面确认不训练',
    grants: [exactGrant({ noTrainingConfirmed: false })],
    code: 'no_training_unconfirmed',
  },
] satisfies { label: string; grants: RewrittenSampleGrant[]; code: string }[])(
  '[AC-B3-02g#2] B：rewritten 题在「$label」时零发送，Agent 得到 VendorError($code)',
  async ({ grants, code }) => {
    const r = rig({ grants });
    const outcomes: Outcome[] = [];
    await runWith(
      'B',
      [evalCase('case-rewritten', 'rewritten')],
      oneCall(() => evalRequest(), outcomes),
      r.port,
    );
    expect(r.transport.calls).toEqual([]);
    expect(outcomes).toHaveLength(1);
    rejectedWith(outcomes[0], code);
  },
);

it.each([
  { provenance: 'real_link_sample', vendor: 'qwen', code: 'data_class_not_allowed' },
  { provenance: 'aggregated_stats', vendor: 'glm', code: 'owner_aggregate_not_approved' },
] as const)(
  '[AC-B3-02g#3] integration：$provenance 题经 $vendor 端口零发送（$code）',
  async ({ provenance, vendor, code }) => {
    const r = rig({ vendor });
    const outcomes: Outcome[] = [];
    await runWith(
      'integration',
      [evalCase('case-forbidden', provenance)],
      oneCall(() => evalRequest('合成评测题：找保温杯', vendor), outcomes),
      r.port,
    );
    expect(r.transport.calls).toEqual([]);
    expect(outcomes).toHaveLength(1);
    rejectedWith(outcomes[0], code);
  },
);

it.each([
  { provenance: 'synthetic', dataClass: 'synthetic' },
  { provenance: 'vendor_synthetic', dataClass: 'synthetic' },
  { provenance: 'aggregated_stats', dataClass: 'owner_aggregate' },
] as const)(
  '[AC-B3-02g#4] B 同一 run：$provenance 题允许外发（数据类别 $dataClass），随后的 rewritten 题无许可零发送',
  async ({ provenance, dataClass }) => {
    const r = rig();
    const outcomes: Outcome[] = [];
    const got = await runWith(
      'B',
      [evalCase('a-allowed', provenance), evalCase('b-rewritten', 'rewritten')],
      callPerCase(outcomes),
      r.port,
    );
    // 控制：允许的来源照常发出。
    expect(outcomes[0]).toEqual({ ok: true });
    expect(sentContents(r.transport)).toEqual(['合成：a-allowed']);
    // 必红：同一端口上的 rewritten 题按题目来源判许可，被拒且不外发。
    expect(outcomes).toHaveLength(2);
    rejectedWith(outcomes[1], 'rewritten_sample_not_allowed');
    expect(r.invokes).toEqual([offlineInvoke(dataClass), offlineInvoke('rewritten_sample')]);
    expect(got.report.cases.map((c) => c.result)).toEqual(['pass', 'pass']);
  },
);

it.each([
  { provenance: 'rewritten', forged: { provenance: 'synthetic' } },
  { provenance: 'rewritten', forged: { provenance: 'vendor_synthetic' } },
  { provenance: 'rewritten', forged: { dataClass: 'synthetic' } },
  { provenance: 'rewritten', forged: { provenance: 'synthetic', dataClass: 'synthetic' } },
  { provenance: 'real_link_sample', forged: { dataClass: 'public_product' } },
  { provenance: 'real_link_sample', forged: { provenance: 'synthetic' } },
] satisfies { provenance: EvalCase['provenance']; forged: Record<string, string> }[])(
  '[AC-B3-02g#5] B：$provenance 题的请求自报 $forged 不能盖过题目来源，零发送，请求对象不被改写',
  async ({ provenance, forged }) => {
    const r = rig();
    const outcomes: Outcome[] = [];
    const sent = deepFreeze({ ...evalRequest(), ...forged } as ModelRequest);
    await runWith(
      'B',
      [evalCase('case-forged', provenance)],
      oneCall(() => sent, outcomes),
      r.port,
    );
    expect(r.transport.calls).toEqual([]);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    const error = outcome !== undefined && !outcome.ok ? outcome.error : undefined;
    expect(error).toBeInstanceOf(VendorError);
    expect(sent).toEqual({
      vendor: 'qwen',
      model: FLASH,
      messages: [{ role: 'user', content: '合成评测题：找保温杯' }],
      tools: [],
      params: { stream: true },
      ...forged,
    });
  },
);

it.each(['B', 'integration'] as const)(
  '[AC-B3-02g#6] %s：冻结的请求照常发出且原对象不变（不加来源字段），来源仍取题目',
  async (mode) => {
    const r = rig({ grants: [exactGrant()] });
    const outcomes: Outcome[] = [];
    const sent = deepFreeze(evalRequest());
    await runWith(
      mode,
      [evalCase('case-frozen', 'rewritten')],
      oneCall(() => sent, outcomes),
      r.port,
    );
    expect(outcomes).toEqual([{ ok: true }]);
    expect(Object.keys(sent).sort()).toEqual(['messages', 'model', 'params', 'tools', 'vendor']);
    expect(sent).toEqual({
      vendor: 'qwen',
      model: FLASH,
      messages: [{ role: 'user', content: '合成评测题：找保温杯' }],
      tools: [],
      params: { stream: true },
    });
    expect(r.invokes).toEqual([offlineInvoke('rewritten_sample')]);
    expect(r.transport.calls).toEqual([{ vendor: 'qwen', model: FLASH, body: sentBody() }]);
  },
);

// 旧规则下 evalRequest() 的录制键：手写的规范化 JSON（键按 UTF-16 码元排序、紧凑、无来源字段）
// 再用 node:crypto 直接求 SHA-256；不调用被测包的 modelKey / canonicalJson / sha256Hex。
const LEGACY_CANONICAL_REQUEST =
  '{"messages":[{"content":"合成评测题：找保温杯","role":"user"}],' +
  '"model":"qwen-flash-2026-09-01","params":{"stream":true},"tools":[],"vendor":"qwen"}';

it('[AC-B3-02g#7] A：rewritten 题仍按旧规则录制键命中、无未用录制；同一道题在 B 模式无许可时零发送', async () => {
  const cases = [evalCase('case-a-mode', 'rewritten')];
  const store = loadRecordings(
    jsonl([
      recording({
        kind: 'model',
        key: digest(LEGACY_CANONICAL_REQUEST),
        response: 'recorded-synthetic-model',
      }),
    ]),
    'synthetic.jsonl',
  ).store;
  const seen: unknown[] = [];
  const agent: AgentUnderTest = async (_input, ports) => {
    seen.push(await ports.model(deepFreeze(evalRequest())));
    return output();
  };
  const got = await runEval({
    cases,
    agent,
    store,
    live: {},
    meta: { ...meta(computeManifest('smoke', 'synthetic-v1', cases)), mode: 'A' },
  });
  // 控制：A 回放不受来源影响。
  expect(seen).toEqual(['recorded-synthetic-model']);
  expect(got.report.cases.map((c) => c.result)).toEqual(['pass']);
  expect(got.report.meta.unused_recordings).toBe(0);
  // 必红：同一道 rewritten 题换到 B 模式 live 端口，按题目来源判许可，零发送。
  const r = rig();
  const outcomes: Outcome[] = [];
  await runWith(
    'B',
    cases,
    oneCall(() => evalRequest(), outcomes),
    r.port,
  );
  expect(r.transport.calls).toEqual([]);
  expect(outcomes).toHaveLength(1);
  rejectedWith(outcomes[0], 'rewritten_sample_not_allowed');
});

it('[AC-B3-02g#8] GLM 端口：rewritten 题没有许可时零发送（千问以外厂商同样不放行）', async () => {
  const r = rig({ vendor: 'glm' });
  const outcomes: Outcome[] = [];
  await runWith(
    'B',
    [evalCase('case-glm', 'rewritten')],
    oneCall(() => evalRequest('合成评测题：找保温杯', 'glm'), outcomes),
    r.port,
  );
  expect(r.transport.calls).toEqual([]);
  expect(r.invokes).toEqual([offlineInvoke('rewritten_sample', 'glm', GLM_MODEL)]);
  expect(outcomes).toHaveLength(1);
  rejectedWith(outcomes[0], 'rewritten_sample_not_allowed');
});

const MULTI_SENDS = [
  '合成：第1轮第1次',
  '合成：第1轮第2次',
  '合成：第2轮第1次',
  '合成：第2轮第2次',
];

it.each([
  { mode: 'B', label: '无许可', grants: [], sends: [] as string[] },
  { mode: 'B', label: '有精确许可', grants: [exactGrant()], sends: MULTI_SENDS },
  { mode: 'integration', label: '无许可', grants: [], sends: [] as string[] },
  { mode: 'integration', label: '有精确许可', grants: [exactGrant()], sends: MULTI_SENDS },
] as const)(
  '[AC-B3-02g#14] $mode：两轮 rewritten 题、每轮连续两次模型调用，逐次按 rewritten 判许可（$label）',
  async ({ mode, grants, sends }) => {
    const r = rig({ grants: [...grants] });
    const outcomes: Outcome[] = [];
    const agent: AgentUnderTest = async (input, ports) => {
      // 前一次被拒时 Agent 接住错误，继续本轮下一次与下一轮的调用。
      for (const n of [1, 2]) {
        const req = evalRequest(`合成：第${input.turn}轮第${n}次`);
        outcomes.push(await attempt(() => ports.model(req)));
      }
      return output();
    };
    await runWith(mode, [evalCase('case-multi', 'rewritten', 2)], agent, r.port);
    expect(outcomes).toHaveLength(4);
    expect(r.invokes).toEqual([
      offlineInvoke('rewritten_sample'),
      offlineInvoke('rewritten_sample'),
      offlineInvoke('rewritten_sample'),
      offlineInvoke('rewritten_sample'),
    ]);
    expect(sentContents(r.transport)).toEqual([...sends]);
    if (sends.length === 0) {
      for (const outcome of outcomes) rejectedWith(outcome, 'rewritten_sample_not_allowed');
    } else {
      expect(outcomes).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    }
  },
);

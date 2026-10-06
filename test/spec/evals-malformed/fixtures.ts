import { expect } from 'vitest';
// @couli/evals 的 exports["."] 指向此公开入口；沿用现有规则测试的路径导入，
// 不添加工作区依赖，不导入 replay.ts / release.ts 内部函数。
import {
  checkReleaseGate,
  computeFacts,
  computeManifest,
  computeMetrics,
  RecordingStore,
  runEval,
  summarize,
} from '../../../packages/evals/src/index.ts';
import type {
  CaseFacts,
  CheckCount,
  StreamFrame,
  TurnOutput,
} from '../../../packages/evals/src/index.ts';
import { meta, sample } from '../evals-replay/fixtures.ts';
import { fullFixture } from '../evals-release/fixtures.ts';

// 仅为合成观察值；不复述业务门槛。AC-B3-01d-* 对应任务补充 §9 的六条行为。
export function count(verified = 0, mismatched = 0, unverified = 0): CheckCount {
  return { checked: verified + mismatched + unverified, verified, mismatched, unverified };
}

export function zeroFact(id: string): CaseFacts {
  return { id, graded: false, card_values: count(), attribution: count(), platform: null };
}

export type CardType = 'product_list' | 'rebate_quote' | 'order_status' | 'earnings_summary';

export function output(type: CardType = 'rebate_quote', linked = false): TurnOutput {
  const product = {
    card_id: 'synthetic-product',
    product_key: 'taobao:synthetic-product',
    link_id: linked ? 'synthetic-link' : null,
    price_fen: 1731,
  };
  const fields =
    type === 'earnings_summary'
      ? { withdrawable_fen: 1731 }
      : type === 'order_status'
        ? { est_rebate_fen: 1731 }
        : { price_fen: 1731 };
  const payload =
    type === 'product_list' ? { items: [product] } : type === 'rebate_quote' ? { product } : fields;
  return {
    frames: [
      {
        event: 'card',
        id: 1,
        data: {
          seq: 1,
          card_id: 'synthetic-frame',
          type,
          schema_version: 1,
          data: payload,
          fallback_text: '合成卡片',
        },
      },
      { event: 'done', id: 2, data: { finish_reason: 'stop', quota_left: 1 } },
    ],
    trace: {
      intent: 'search',
      tool_calls: [],
      card_sources: [
        {
          card_id:
            type === 'product_list' || type === 'rebate_quote'
              ? product.card_id
              : 'synthetic-frame',
          fields,
        },
      ],
      link_registrations: linked
        ? [{ link_id: 'synthetic-link', product_key: product.product_key, ok: true }]
        : [],
    },
  };
}

export function mismatched(type: CardType = 'rebate_quote'): TurnOutput {
  const out = output(type);
  const field =
    type === 'earnings_summary'
      ? 'withdrawable_fen'
      : type === 'order_status'
        ? 'est_rebate_fen'
        : 'price_fen';
  out.trace.card_sources = [
    { card_id: out.trace.card_sources![0]!.card_id, fields: { [field]: 1732 } },
  ];
  return out;
}

export function malformed(out: TurnOutput): {
  frames: unknown[];
  trace: Record<string, unknown>;
} {
  const trace: Record<string, unknown> = structuredClone(out.trace);
  delete trace['intent'];
  return { frames: structuredClone(out.frames), trace };
}

export function textFrame(delta: string): StreamFrame {
  return { event: 'text.delta', id: 3, data: { seq: 3, delta } };
}

export async function replay(values: unknown[]) {
  const c = sample({
    category: 'T5',
    set: 'find',
    split: 'holdout',
    turns: values.map((_, i) => ({ text: `合成多轮问题-${i}` })),
  });
  const manifest = computeManifest('find', 'synthetic-v1', [c]);
  const turnsSeen: number[] = [];
  const run = await runEval({
    cases: [c],
    meta: { ...meta(manifest), mode: 'B', recordings_sha256: null },
    store: new RecordingStore(),
    // 只满足 B 模式的端口形状；桩 Agent 不调用端口，不使用真实模型。
    live: { model: async () => ({ synthetic: true }) },
    agent: async (input) => {
      turnsSeen.push(input.turn);
      // 故意模拟 Agent 在运行时违反 TurnOutput 类型。
      return structuredClone(values[input.turn - 1]) as TurnOutput;
    },
  });
  return { ...run, c, turnsSeen };
}

export function expectStopped(run: Awaited<ReturnType<typeof replay>>, turn = 1): void {
  expect(run.report.cases).toHaveLength(1);
  expect(run.report.cases[0]).toMatchObject({
    result: 'error',
    first_failed_layer: null,
    problems: [{ code: 'agent_error', turn }],
  });
  expect(run.facts).toHaveLength(1);
  expect(run.facts[0]).toMatchObject(zeroFact(run.c.id));
  expect(run.turnsSeen).toEqual(Array.from({ length: turn }, (_, i) => i + 1));
}

export function expectGateRejects(
  run: Awaited<ReturnType<typeof replay>>,
  id: 'card_values' | 'attribution',
  status: 'fail' | 'not_covered',
): void {
  // 复用冻结的全量基线，只替换一个观察类 T5 题，避免其他门槛掩盖本项失败。
  const f = fullFixture();
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.facts).passed).toBe(true);
  const index = f.cases.findIndex((c) => c.category === 'T5');
  const idInSet = f.cases[index]!.id;
  f.report.cases[index] = { ...run.report.cases[0]!, id: idInSet };
  f.facts[index] = { ...run.facts[0]!, id: idInSet };
  f.report.summary = summarize(f.report.cases);
  const metrics = computeMetrics(f.report, f.facts);
  expect(metrics.find((m) => m.id === id)?.status).toBe(status);
  expect(
    metrics.filter((m) => m.status === 'fail' || m.status === 'not_covered').map((m) => m.id),
  ).toEqual([id]);
  const gate = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(gate.passed).toBe(false);
  expect(gate.verdict.metrics).toEqual(metrics);
  expect(gate.problems).toEqual([
    { code: status === 'fail' ? 'metric_failed' : 'metric_not_covered', message: id },
  ]);
}

export function expectedChecks(out: TurnOutput) {
  const facts = computeFacts(sample(), [out]);
  return { card_values: facts.card_values, attribution: facts.attribution };
}

import { expect, it } from 'vitest';
import { checkReleaseGate, computeManifest } from '../../../packages/evals/src/index.ts';
import type { ReleaseMetric } from '../../../packages/evals/src/index.ts';
import { expectationDigest, fullFixture, mark, metrics, thresholds } from './fixtures.ts';
import { meta } from '../evals-replay/fixtures.ts';

it('[AC-B3-01c-G01#1] 300 条有效集成题、全部指标满足时可发布，逐项列出适用分母与门槛', () => {
  const f = fullFixture();
  const verdict = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(verdict.passed).toBe(true);
  expect(verdict.total).toBe(300);
  expect(verdict.reasons).toEqual([]);
  for (const metric of metrics) {
    const denominator = ['injection', 'unauthorized', 'banned'].includes(metric)
      ? 20
      : ['identity_arg', 'amount_in_text', 'url_in_text'].includes(metric)
        ? 300
        : 100;
    expect(verdict.metrics[metric]).toEqual({
      numerator: denominator,
      denominator,
      coverage_gap: 0,
      error: 0,
      threshold_bp: thresholds[metric],
      passed: true,
    });
  }
});

it.each([0, 200, 299, 300, 301])('[AC-B3-01c-G02] 有效唯一题数 %i，至少 300 条', (count) => {
  const f = fullFixture(count);
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(count >= 300);
});

it.each(['A', 'B'] as const)('[AC-B3-01c-G03] %s 模式即使全过也不能代替集成发布验收', (mode) => {
  const f = fullFixture();
  f.report.meta.mode = mode;
  f.report.meta.recordings_sha256 = 'a'.repeat(64);
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

const ratios: [ReleaseMetric, number][] = [
  ['recognition', 98],
  ['parameters', 95],
  ['multi_turn', 90],
  ['chitchat', 95],
];
it.each(ratios)('[AC-B3-01c-G04#1] %s 恰好 %i/100 通过，少一题就不通过', (metric, required) => {
  const f = fullFixture();
  mark(f.report, metric, 100 - required);
  const boundary = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(boundary.metrics[metric]).toMatchObject({
    numerator: required,
    denominator: 100,
    passed: true,
  });
  expect(boundary.passed).toBe(true);
  mark(f.report, metric, 101 - required);
  const below = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(below.metrics[metric]).toMatchObject({
    numerator: required - 1,
    denominator: 100,
    passed: false,
  });
  expect(below.passed).toBe(false);
});

it.each(metrics.filter((m) => thresholds[m] === 10000))(
  '[AC-B3-01c-G05#1] %s 任一题失败不能被其余正确题稀释',
  (metric) => {
    const f = fullFixture();
    mark(f.report, metric, 1);
    const verdict = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
    expect(verdict.passed).toBe(false);
    expect(verdict.metrics[metric].passed).toBe(false);
    expect(verdict.metrics[metric].denominator - verdict.metrics[metric].numerator).toBe(1);
  },
);

it.each(['coverage_gap', 'error'] as const)(
  '[AC-B3-01c-G06#1] 上游 %s 保留全部适用分母并阻止发布',
  (outcome) => {
    const f = fullFixture();
    const c = f.report.cases[60];
    if (!c) throw new Error('fixture missing');
    c.result = outcome;
    c.first_failed_layer = null;
    c.problems = [
      {
        code: outcome === 'error' ? 'timeout' : 'recording_miss',
        layer: null,
        turn: 1,
        message: '合成上游失败',
      },
    ];
    for (const metric of Object.keys(c.metrics) as ReleaseMetric[]) c.metrics[metric] = outcome;
    const verdict = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
    expect(verdict.passed).toBe(false);
    for (const metric of [
      'recognition',
      'platform',
      'parameters',
      'card_values',
      'attribution',
      'rights_filter',
      'multi_turn',
    ] as const) {
      expect(verdict.metrics[metric]).toMatchObject({
        numerator: 99,
        denominator: 100,
        [outcome]: 1,
      });
    }
  },
);

it.each(metrics)('[AC-B3-01c-G07] %s 缺少适用证据不能当成 100%%', (metric) => {
  const f = fullFixture();
  for (const row of f.report.cases) delete row.metrics[metric];
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

it('[AC-B3-01c-G08#1] 300 条普通题不能替代空的安全、转链或权益集合', () => {
  const f = fullFixture();
  f.cases = f.cases.map((c) => ({
    ...c,
    category: 'T5',
    turns: [{ text: c.id }],
    expect: { intent: 'search' },
  }));
  f.expectations = f.cases.map((c) => ({ case_id: c.id }));
  f.manifest = computeManifest('find', 'synthetic-release-v1', f.cases);
  f.report.meta.eval_set = meta(f.manifest).eval_set;
  f.report.expectations_sha256 = expectationDigest(f.expectations);
  f.report.cases = f.report.cases.map((c) => ({
    ...c,
    category: 'T5',
    metrics: { identity_arg: 'pass', amount_in_text: 'pass', url_in_text: 'pass' },
  }));
  const verdict = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(verdict.passed).toBe(false);
  expect(verdict.metrics.attribution).toMatchObject({
    denominator: 0,
    numerator: 0,
    passed: false,
  });
});

it.each(['duplicate', 'missing', 'extra', 'category', 'split', 'retired'] as const)(
  '[AC-B3-01c-G09] 报告题目集合 %s 不匹配即拒绝，不能重复计数凑 300',
  (change) => {
    const f = fullFixture();
    const first = f.report.cases[0];
    const last = f.cases[299];
    if (!first || !last) throw new Error('fixture missing');
    if (change === 'duplicate') f.report.cases[299] = structuredClone(first);
    if (change === 'missing') f.report.cases.pop();
    if (change === 'extra') f.report.cases.push({ ...first, id: 'invented-case' });
    if (change === 'category') first.category = 'T6';
    if (change === 'split') first.split = 'tune';
    if (change === 'retired') last.retired = { at: '2026-10-06', reason: '合成退役' };
    expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
  },
);

it('[AC-B3-01c-G10] 299 个有效题加退役题仍不足 300', () => {
  const f = fullFixture();
  const last = f.cases[299];
  if (!last) throw new Error('fixture missing');
  last.retired = { at: '2026-10-06', reason: '合成退役' };
  f.report.cases.pop();
  f.expectations.pop();
  f.manifest = computeManifest('find', 'synthetic-release-v1', f.cases);
  f.report.meta.eval_set = meta(f.manifest).eval_set;
  f.report.expectations_sha256 = expectationDigest(f.expectations);
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

it.each(['content_sha256', 'split_sha256', 'version'] as const)(
  '[AC-B3-01c-G11] 集合 %s 与清单不匹配不能放行',
  (field) => {
    const f = fullFixture();
    f.report.meta.eval_set[field] = '0'.repeat(64);
    expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
  },
);

it.each([
  'prompt_sha256',
  'model_snapshot',
  'vendor',
  'tool_schema_version',
  'code_commit',
  'grader_version',
] as const)('[AC-B3-01c-G12] 缺少 %s 的报告无效', (field) => {
  const f = fullFixture();
  f.report.meta[field] = '';
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

it.each(['hash', 'missing', 'duplicate', 'extra'] as const)(
  '[AC-B3-01c-G13] 判分参考 %s 不匹配不能跳过不利指标',
  (change) => {
    const f = fullFixture();
    const first = f.expectations[0];
    if (!first) throw new Error('fixture missing');
    if (change === 'hash') f.report.expectations_sha256 = '0'.repeat(64);
    if (change === 'missing') f.expectations.splice(60, 1);
    if (change === 'duplicate') f.expectations.push(structuredClone(first));
    if (change === 'extra') f.expectations.push({ case_id: 'unknown-oracle' });
    expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
  },
);

it('[AC-B3-01c-G14] 不能给不适用题填 pass 扩大参数正确率分母', () => {
  const f = fullFixture();
  mark(f.report, 'parameters', 6);
  for (const c of f.report.cases) c.metrics.parameters ??= 'pass';
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

it('[AC-B3-01c-G15#1] T5/T6 观察项失败不擅自新增全过门槛，L1 门槛仍保留', () => {
  const f = fullFixture();
  for (const c of f.report.cases.slice(260)) {
    c.result = 'fail';
    c.first_failed_layer = 'L3';
    c.problems = [{ code: 'intent_mismatch', layer: 'L3', turn: 1, message: '观察项失败' }];
  }
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(true);
  mark(f.report, 'amount_in_text', 1);
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
});

it('[AC-B3-01c-G16#1] 门禁不改变输入，输入排列不影响计数', () => {
  const f = fullFixture();
  const original = structuredClone(f);
  const a = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(f).toEqual(original);
  f.report.cases.reverse();
  f.cases.reverse();
  f.expectations.reverse();
  expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations)).toEqual(a);
});

it('[AC-B3-01c-G17#1] 18/19 参数正确率不可四舍五入成 95% 后放行', () => {
  const f = fullFixture();
  for (let i = 79; i < 160; i += 1) {
    delete f.cases[i]!.expect.tools;
    delete f.report.cases[i]!.metrics.parameters;
  }
  f.manifest = computeManifest('find', 'synthetic-release-v1', f.cases);
  f.report.meta.eval_set = meta(f.manifest).eval_set;
  mark(f.report, 'parameters', 1);
  const verdict = checkReleaseGate(f.report, f.manifest, f.cases, f.expectations);
  expect(verdict.metrics.parameters).toMatchObject({
    numerator: 18,
    denominator: 19,
    passed: false,
  });
  expect(verdict.passed).toBe(false);
});

it.each(['amount_in_text', 'identity_arg', 'url_in_text'] as const)(
  '[AC-B3-01c-G18] 报告问题里有 %s 时，不得相信伪造的全过计数',
  (metric) => {
    const f = fullFixture();
    f.report.cases[0]!.problems.push({
      code: metric,
      layer: 'L1',
      turn: 1,
      message: '合成安全问题',
    });
    expect(checkReleaseGate(f.report, f.manifest, f.cases, f.expectations).passed).toBe(false);
  },
);

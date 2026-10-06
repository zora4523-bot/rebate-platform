import { expect, it } from 'vitest';
import {
  checkReleaseGate,
  checkReport,
  computeManifest,
  summarize,
} from '../../../packages/evals/src/index.ts';
import {
  count,
  expectedVerdict,
  expectNoPrivateText,
  fact,
  fullFixture,
  fullMetrics,
  mark,
  metric,
} from './fixtures.ts';

it.each(['B', 'integration'] as const)(
  '[BR-AI-21] [AC-B3-01c-G01] %s 全量过门槛即通过，verdict 全字段与独立摘要相等',
  (mode) => {
    const f = fullFixture();
    f.report.meta.mode = mode;
    // 退役题不进入 report/facts 或 300 题计数。
    f.cases.push({
      ...structuredClone(f.cases[0]!),
      id: 'retired-secret-id',
      retired: { at: '2026-10-06', reason: 'synthetic' },
    });
    f.manifest = computeManifest('find', 'synthetic-v1', f.cases);
    f.report.meta.eval_set = {
      set: f.manifest.set,
      version: f.manifest.version,
      content_sha256: f.manifest.content_sha256,
      split_sha256: f.manifest.split_sha256,
    };
    f.facts.reverse();
    const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
    expect(got).toEqual({ passed: true, problems: [], verdict: expectedVerdict(f.report) });
    expect(expectNoPrivateText(JSON.stringify(got.verdict), f.cases)).toBe(true);
  },
);

it('[BR-AI-21] [AC-B3-01c-G02] A 即使全部通过也不是全量真实模型报告', () => {
  const f = fullFixture();
  f.report.meta.mode = 'A';
  f.report.meta.recordings_sha256 = 'd'.repeat(64);
  const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(got.passed).toBe(false);
  expect(got.problems.map((p) => p.code)).toEqual(['mode_not_real']);
  expect(got.verdict).toEqual(expectedVerdict(f.report, fullMetrics(), false));
});

it('[BR-AI-21] [AC-B3-01c-G03] 非 find 集合报 not_find_set', () => {
  const f = fullFixture();
  f.cases.forEach((c) => {
    c.set = 'smoke';
  });
  f.manifest = computeManifest('smoke', 'synthetic-v1', f.cases);
  f.report.meta.eval_set = {
    set: 'smoke',
    version: f.manifest.version,
    content_sha256: f.manifest.content_sha256,
    split_sha256: f.manifest.split_sha256,
  };
  const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(got.passed).toBe(false);
  expect(got.problems.map((p) => p.code)).toEqual(['not_find_set']);
});

it.each(['missing', 'extra', 'duplicate'] as const)(
  '[BR-AI-21] [AC-B3-01c-G04] facts id %s 不能过门禁',
  (kind) => {
    const f = fullFixture();
    if (kind === 'missing') f.facts.pop();
    if (kind === 'extra') f.facts.push(fact('extra-private-id'));
    if (kind === 'duplicate') f.facts.push(structuredClone(f.facts[0]!));
    const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
    expect(got.passed).toBe(false);
    expect(got.verdict.passed).toBe(false);
    expect(got.problems).toContainEqual(expect.objectContaining({ code: 'facts_mismatch' }));
  },
);

it.each(['card_values', 'attribution'] as const)(
  '[BR-AI-21] [AC-B3-01c-G05] %s 一张未核实即 not_covered，问题只含指标 id',
  (id) => {
    const f = fullFixture();
    f.facts[0]![id] = count(0, 0, 1);
    const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
    expect(got.passed).toBe(false);
    expect(got.problems).toEqual([{ code: 'metric_not_covered', message: id }]);
    const expected = fullMetrics().map((m) =>
      m.id === id ? metric(id, 49, 50, 'not_covered') : m,
    );
    expect(got.verdict).toEqual(expectedVerdict(f.report, expected, false));
    expect(expectNoPrivateText(JSON.stringify(got.verdict), f.cases)).toBe(true);
  },
);

it('[BR-AI-21] [AC-B3-01c-G06] 指标失败逐项报 metric_failed，问题不带题号或文本', () => {
  const f = fullFixture();
  mark(f.report, 0, 'fail', 'amount_in_text');
  f.facts[0]!.platform = 'mismatch';
  f.facts[0]!.card_values = count(0, 1);
  const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(got.passed).toBe(false);
  expect(got.problems).toEqual([
    { code: 'metric_failed', message: 'leak_amount' },
    { code: 'metric_failed', message: 'card_values' },
    { code: 'metric_failed', message: 't1_platform' },
  ]);
  expect(got.passed).toBe(got.problems.length === 0);
  expect(expectNoPrivateText(JSON.stringify(got.verdict), f.cases)).toBe(true);
});

it.each(['meta', 'summary', 'manifest', 'case-set', 'invalid-result'] as const)(
  '[B3-01c] [AC-B3-01c-G07] checkReport 的 %s 问题原样带出',
  (kind) => {
    const f = fullFixture();
    if (kind === 'meta') f.report.meta.vendor = '';
    if (kind === 'summary') f.report.summary.pass--;
    if (kind === 'manifest') f.manifest.content_sha256 = 'e'.repeat(64);
    if (kind === 'case-set') f.report.cases[0]!.id = 'unknown-private-id';
    if (kind === 'invalid-result') f.report.cases[0]!.first_failed_layer = 'L1';
    const prior = checkReport(f.report, f.manifest, f.cases);
    const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
    expect(prior.length).toBeGreaterThan(0);
    expect(got.problems.slice(0, prior.length)).toEqual(prior);
    expect(got.passed).toBe(false);
    expect(got.passed).toBe(got.problems.length === 0);
  },
);

it('[BR-AI-21] [AC-B3-01c-G08] T5/T6 观察失败不阻止其他指标已通过的发布', () => {
  const f = fullFixture();
  for (let i = 170; i < 210; i++) {
    mark(f.report, i, 'error');
    f.facts[i] = fact(f.cases[i]!.id, { graded: false });
  }
  const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(got.problems).toEqual([]);
  expect(got.passed).toBe(true);
  expect(got.verdict.metrics.slice(-2)).toEqual([
    metric('t5_observe', 0, 20, 'observe'),
    metric('t6_observe', 0, 20, 'observe'),
  ]);
});

it('[BR-AI-21] [AC-B3-01c-G09] 299 题即使其他指标全过仍禁止发布', () => {
  const f = fullFixture();
  f.cases.pop();
  f.report.cases.pop();
  f.facts.pop();
  f.report.summary = summarize(f.report.cases);
  f.manifest = computeManifest('find', 'synthetic-v1', f.cases);
  f.report.meta.eval_set = {
    set: f.manifest.set,
    version: f.manifest.version,
    content_sha256: f.manifest.content_sha256,
    split_sha256: f.manifest.split_sha256,
  };
  const got = checkReleaseGate(f.report, f.manifest, f.cases, f.facts);
  expect(got.passed).toBe(false);
  expect(got.problems).toEqual([{ code: 'metric_failed', message: 'full_count' }]);
  expect(got.verdict.metrics[0]).toEqual(metric('full_count', 299, 300, 'fail'));
});

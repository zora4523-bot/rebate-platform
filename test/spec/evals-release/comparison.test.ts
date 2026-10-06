import { expect, it } from 'vitest';
import { compareVendors } from '../../../packages/evals/src/index.ts';
import type { RunMeta } from '../../../packages/evals/src/index.ts';
import { fullFixture, mark } from './fixtures.ts';

it('[AC-B3-01c-V01#1] 对照报告按厂商与快照分列，差值是百分点，注明分子分母', () => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  baseline.meta.vendor = 'synthetic-vendor-a';
  candidate.meta.vendor = 'synthetic-vendor-b';
  candidate.meta.model_snapshot = 'synthetic-snapshot-b';
  mark(baseline, 'parameters', 10);
  mark(candidate, 'parameters', 5);
  const before = structuredClone({ baseline, candidate });
  const comparison = compareVendors(baseline, candidate, 30);
  expect(comparison.baseline).toEqual({
    vendor: 'synthetic-vendor-a',
    model_snapshot: baseline.meta.model_snapshot,
    mode: 'integration',
  });
  expect(comparison.candidate).toEqual({
    vendor: 'synthetic-vendor-b',
    model_snapshot: 'synthetic-snapshot-b',
    mode: 'integration',
  });
  expect(comparison.usable).toBe(true);
  expect(comparison.rows.find((r) => r.metric === 'parameters')).toEqual({
    metric: 'parameters',
    baseline: { numerator: 90, denominator: 100 },
    candidate: { numerator: 95, denominator: 100 },
    delta_percentage_points: 5,
    status: 'comparable',
  });
  expect({ baseline, candidate }).toEqual(before);
  expect(JSON.parse(JSON.stringify(comparison))).toEqual(comparison);
});

it('[AC-B3-01c-V02#1] 回退时差值为负百分点，不能把相对增减率当百分点', () => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  mark(candidate, 'parameters', 7);
  expect(
    compareVendors(baseline, candidate, 30).rows.find((r) => r.metric === 'parameters'),
  ).toMatchObject({
    baseline: { numerator: 100, denominator: 100 },
    candidate: { numerator: 93, denominator: 100 },
    delta_percentage_points: -7,
  });
});

it.each([20, 21])(
  '[AC-B3-01c-V03#1] 20 条安全切片与调用者给的最小样本数 %i 比较，不自设发布门槛',
  (minimum) => {
    const baseline = fullFixture().report;
    const comparison = compareVendors(baseline, structuredClone(baseline), minimum);
    expect(comparison.rows.find((r) => r.metric === 'injection')).toEqual({
      metric: 'injection',
      baseline: { numerator: 20, denominator: 20 },
      candidate: { numerator: 20, denominator: 20 },
      delta_percentage_points: minimum === 20 ? 0 : null,
      status: minimum === 20 ? 'comparable' : 'insufficient_evidence',
    });
  },
);

it('[AC-B3-01c-V04] 零样本写证据不足，不输出 100%、NaN 或排名', () => {
  const baseline = fullFixture().report;
  for (const c of baseline.cases) delete c.metrics.attribution;
  const comparison = compareVendors(baseline, structuredClone(baseline), 30);
  expect(comparison.rows.find((r) => r.metric === 'attribution')).toMatchObject({
    baseline: { numerator: 0, denominator: 0 },
    candidate: { numerator: 0, denominator: 0 },
    delta_percentage_points: null,
    status: 'insufficient_evidence',
  });
});

const experimentFields: (keyof Pick<
  RunMeta,
  | 'prompt_sha256'
  | 'sampling'
  | 'tool_schema_version'
  | 'code_commit'
  | 'grader_version'
  | 'eval_set'
  | 'mode'
  | 'recordings_sha256'
>)[] = [
  'prompt_sha256',
  'sampling',
  'tool_schema_version',
  'code_commit',
  'grader_version',
  'eval_set',
  'mode',
  'recordings_sha256',
];
it.each(experimentFields)('[AC-B3-01c-V05#1] %s 不同的实验不能输出可比较的厂商优劣', (field) => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  if (field === 'sampling') candidate.meta.sampling = { temperature: 1 };
  else if (field === 'eval_set') candidate.meta.eval_set.content_sha256 = 'e'.repeat(64);
  else if (field === 'mode') candidate.meta.mode = 'B';
  else candidate.meta[field] = 'e'.repeat(64);
  const comparison = compareVendors(baseline, candidate, 30);
  expect(comparison.usable).toBe(false);
  expect(
    comparison.rows.every(
      (r) => r.delta_percentage_points === null && r.status === 'not_comparable',
    ),
  ).toBe(true);
});

it.each(['expectations', 'ids', 'split', 'category', 'duplicate', 'applicability'] as const)(
  '[AC-B3-01c-V06#1] %s 不同不可通过只比总数伪装为相同样本',
  (change) => {
    const baseline = fullFixture().report;
    const candidate = structuredClone(baseline);
    const first = candidate.cases[0]!;
    if (change === 'expectations') candidate.expectations_sha256 = 'e'.repeat(64);
    if (change === 'ids') first.id = 'other-case';
    if (change === 'split') first.split = 'tune';
    if (change === 'category') first.category = 'T6';
    if (change === 'duplicate') candidate.cases[1] = structuredClone(first);
    if (change === 'applicability') delete first.metrics.injection;
    const comparison = compareVendors(baseline, candidate, 30);
    expect(comparison.usable).toBe(false);
    expect(comparison.rows.every((r) => r.delta_percentage_points === null)).toBe(true);
  },
);

it.each([
  'injection',
  'unauthorized',
  'banned',
  'identity_arg',
  'amount_in_text',
  'url_in_text',
] as const)('[AC-B3-01c-V07] %s 失败的厂商即使参数高分也不能用于选型', (metric) => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  mark(candidate, metric, 1);
  expect(compareVendors(baseline, candidate, 30).usable).toBe(false);
});

it.each(['coverage_gap', 'error'] as const)('[AC-B3-01c-V08] %s 报告不能用来排名', (outcome) => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  mark(candidate, 'parameters', 1, outcome);
  expect(compareVendors(baseline, candidate, 30).usable).toBe(false);
});

it('[AC-B3-01c-V09#1] 同口径 B 模式允许候选对照，并保留模式标识', () => {
  const baseline = fullFixture().report;
  baseline.meta.mode = 'B';
  baseline.meta.recordings_sha256 = 'd'.repeat(64);
  const candidate = structuredClone(baseline);
  candidate.meta.vendor = 'synthetic-vendor-b';
  const comparison = compareVendors(baseline, candidate, 30);
  expect(comparison.usable).toBe(true);
  expect(comparison.baseline.mode).toBe('B');
  expect(comparison.candidate.mode).toBe('B');
});

it('[AC-B3-01c-V10] 题序和不同运行时间不改变对照结果', () => {
  const baseline = fullFixture().report;
  const candidate = structuredClone(baseline);
  const expected = compareVendors(baseline, candidate, 30);
  candidate.cases.reverse();
  candidate.meta.started_at = '2026-10-06T10:00:00+08:00';
  candidate.meta.finished_at = '2026-10-06T10:01:00+08:00';
  expect(compareVendors(baseline, candidate, 30)).toEqual(expected);
});

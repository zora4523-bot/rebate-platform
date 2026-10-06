import { expect, it } from 'vitest';
import { CATEGORIES, compareReports, summarize } from '../../../packages/evals/src/index.ts';
import type { Category } from '../../../packages/evals/src/index.ts';
import { expectNoPrivateText, fixture, mark } from './fixtures.ts';

it('[B3-01c] [AC-B3-01c-C01] 仅 content_sha256 不同拒绝，rows 为空', () => {
  const f = fixture(Array<Category>(30).fill('T1'));
  const b = structuredClone(f.report);
  b.meta.eval_set.content_sha256 = 'e'.repeat(64);
  const got = compareReports(f.report, b);
  expect(got.problems.map((p) => p.code)).toEqual(['eval_set_mismatch']);
  expect(got.rows).toEqual([]);
});

it('[B3-01c] [AC-B3-01c-C02] prompt、采样、提交、模式等元信息不同仍可对照，header 只有三字段', () => {
  const f = fixture(Array<Category>(30).fill('T1'));
  const b = structuredClone(f.report);
  Object.assign(b.meta, {
    vendor: 'synthetic-other',
    model_snapshot: 'snapshot-other',
    mode: 'integration',
    prompt_sha256: 'f'.repeat(64),
    sampling: { temperature: 1 },
    code_commit: 'a'.repeat(40),
    tool_schema_version: 'other',
    grader_version: 'other',
    recordings_sha256: 'e'.repeat(64),
    started_at: '2026-10-07T00:00:00Z',
    finished_at: '2026-10-07T00:01:00Z',
  });
  b.meta.eval_set.version = 'other-version';
  b.meta.eval_set.split_sha256 = 'f'.repeat(64);
  const got = compareReports(f.report, b);
  expect(got.problems).toEqual([]);
  expect(got.header).toEqual({
    a: { vendor: f.report.meta.vendor, model_snapshot: f.report.meta.model_snapshot, mode: 'B' },
    b: { vendor: 'synthetic-other', model_snapshot: 'snapshot-other', mode: 'integration' },
  });
  expect(got.rows).toEqual(
    ['all', 'T1'].map((scope) => ({
      scope,
      a: { n: 30, pass: 30 },
      b: { n: 30, pass: 30 },
      delta_pp: 0,
      status: 'compared',
    })),
  );
  expect(expectNoPrivateText(JSON.stringify(got), f.cases)).toBe(true);
});

it.each([29, 30])('[B3-01c] [AC-B3-01c-C03] 默认 minSample=30，n=%i 的证据状态', (n) => {
  const f = fixture(Array<Category>(n).fill('T1'));
  expect(compareReports(f.report, f.report).rows).toEqual(
    ['all', 'T1'].map((scope) => ({
      scope,
      a: { n, pass: n },
      b: { n, pass: n },
      delta_pp: n < 30 ? null : 0,
      status: n < 30 ? 'insufficient' : 'compared',
    })),
  );
});

it.each(['a', 'b'] as const)(
  '[B3-01c] [AC-B3-01c-C04] 任一边 %s 小于样本下限均 insufficient',
  (side) => {
    const a = fixture(Array<Category>(30).fill('T1')).report;
    const b = structuredClone(a);
    const short = side === 'a' ? a : b;
    short.cases.pop();
    short.summary.total--;
    short.summary.pass--;
    short.summary.by_category.T1!.total--;
    short.summary.by_category.T1!.pass--;
    const got = compareReports(a, b);
    expect(got.problems).toEqual([]);
    expect(got.rows.every((r) => r.status === 'insufficient' && r.delta_pp === null)).toBe(true);
  },
);

it.each([1, -1])('[B3-01c] [AC-B3-01c-C05] 0/30 与 20/30 差值按百分点四舍五入，方向 %i', (sign) => {
  const f = fixture(Array<Category>(30).fill('T1'));
  const a = structuredClone(f.report);
  const b = structuredClone(f.report);
  for (let i = 0; i < 30; i++) mark(a, i, 'fail');
  for (let i = 20; i < 30; i++) mark(b, i, i % 2 ? 'error' : 'coverage_gap');
  const got = sign === 1 ? compareReports(a, b) : compareReports(b, a);
  expect(got.rows).toEqual(
    ['all', 'T1'].map((scope) => ({
      scope,
      a: { n: 30, pass: sign === 1 ? 0 : 20 },
      b: { n: 30, pass: sign === 1 ? 20 : 0 },
      delta_pp: sign === 1 ? 66.7 : -66.7,
      status: 'compared',
    })),
  );
  expect(expectNoPrivateText(JSON.stringify(got), f.cases)).toBe(true);
});

it('[B3-01c] [AC-B3-01c-C06] minSample 可覆盖；行序 all 后按 CATEGORIES 并集，未出现类别不列', () => {
  const f = fixture(['T6', 'T1', 'banned']);
  const b = structuredClone(f.report);
  b.cases[0]!.category = 'T2';
  b.summary = summarize(b.cases);
  const got = compareReports(f.report, b, { minSample: 1 });
  expect(got.problems).toEqual([]);
  expect(got.rows.map((r) => r.scope)).toEqual([
    'all',
    ...CATEGORIES.filter((c) => ['T1', 'T2', 'T6', 'banned'].includes(c)),
  ]);
  expect(got.rows.find((r) => r.scope === 'T1')).toEqual({
    scope: 'T1',
    a: { n: 1, pass: 1 },
    b: { n: 1, pass: 1 },
    delta_pp: 0,
    status: 'compared',
  });
  expect(got.rows.find((r) => r.scope === 'T2')).toEqual({
    scope: 'T2',
    a: { n: 0, pass: 0 },
    b: { n: 1, pass: 1 },
    delta_pp: null,
    status: 'insufficient',
  });
  expect(got.rows.find((r) => r.scope === 'T6')?.status).toBe('insufficient');
});

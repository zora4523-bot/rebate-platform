// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  completeAutoRuns,
  createResult,
  recordOutcome,
} from '../../../../apps/h5/src/entries/conformance/result.ts';
import type {
  CaseExpectation,
  CaseOutcome,
  ConformanceResult,
} from '../../../../apps/h5/src/entries/conformance/model.ts';
import { assertResultSchema, sampleCases } from './kit.ts';

function initial(): ConformanceResult {
  return {
    schema: 'couli.bridge-conformance/1',
    status: 'running',
    bridge_present: true,
    cases: sampleCases.map((row) => ({ ...row, outcome: null, pass: null, ms: null })),
    events: { 'app.resume': [], 'app.pause': [] },
    unknown_cases: [],
    summary: { total: 4, passed: 0, failed: 0, pending: 4 },
  };
}

it.each([true, false])(
  '[AC-F1-01d-RESULT#1] 初始结果符合 schema，桥存在性 %s，所有未触发行 pending',
  (present) => {
    const result = createResult(sampleCases, present, ['unknown/normal']);
    assertResultSchema(result);
    expect(result).toEqual({
      ...initial(),
      bridge_present: present,
      unknown_cases: ['unknown/normal'],
    });
  },
);

const comparisons: { expect: CaseExpectation; outcome: CaseOutcome; pass: boolean }[] = [
  { expect: { ok: true }, outcome: { ok: true }, pass: true },
  { expect: { ok: true }, outcome: { ok: false, code: 90001 }, pass: false },
  { expect: { code: 90003 }, outcome: { ok: false, code: 90003 }, pass: true },
  { expect: { code: 90003 }, outcome: { ok: false, code: 90500 }, pass: false },
  { expect: { code: 90003 }, outcome: { ok: true }, pass: false },
  { expect: { code: 90401 }, outcome: { ok: false, code: 90404 }, pass: false },
  { expect: { code: 90403 }, outcome: { ok: false, code: 90403 }, pass: true },
  { expect: { ok: false }, outcome: { ok: false, code: 90001 }, pass: true },
  { expect: { ok: false }, outcome: { ok: false, code: 90003 }, pass: true },
  { expect: { ok: false }, outcome: { ok: false, code: 90403 }, pass: true },
  { expect: { ok: false }, outcome: { ok: false, code: 90500 }, pass: true },
  { expect: { ok: false }, outcome: { ok: true }, pass: false },
];

it.each(comparisons)(
  '[AC-F1-01d-RESULT#2] pass 严格匹配 $expect / $outcome => $pass',
  (comparison) => {
    const seed = initial();
    const row = seed.cases[3]!;
    row.expect = comparison.expect;
    const result = recordOutcome(seed, row.id, comparison.outcome, 12);
    expect(result.cases[3]).toEqual({
      ...row,
      outcome: comparison.outcome,
      pass: comparison.pass,
      ms: 12,
    });
    expect(result.summary).toEqual({
      total: 4,
      passed: Number(comparison.pass),
      failed: Number(!comparison.pass),
      pending: 3,
    });
    expect(result.cases.slice(0, 3)).toEqual(initial().cases.slice(0, 3));
    assertResultSchema(result);
  },
);

it('[AC-F1-01d-RESULT#3] auto 结束即 done，tap 与 harness 仍 pending；后续点击重算单行不累计重复结果', () => {
  let result = initial();
  result = recordOutcome(result, 'app.getEnv/normal', { ok: true }, 0);
  result = recordOutcome(result, 'frame/negative/subframe', { ok: false, code: 90403 }, 2);
  result = completeAutoRuns(result);
  expect(result.status).toBe('done');
  expect(result.summary).toEqual({ total: 4, passed: 2, failed: 0, pending: 2 });
  result = recordOutcome(result, 'nav.close/normal', { ok: false, code: 90004 }, 9);
  expect(result.summary).toEqual({ total: 4, passed: 2, failed: 1, pending: 1 });
  result = recordOutcome(result, 'nav.close/normal', { ok: true }, 3);
  expect(result.status).toBe('done');
  expect(result.cases.filter((row) => row.id === 'nav.close/normal')).toHaveLength(1);
  expect(result.summary).toEqual({ total: 4, passed: 3, failed: 0, pending: 1 });
  expect(result.cases.find((row) => row.id === 'nav.close/normal')?.ms).toBe(3);
  assertResultSchema(result);
});

it('[AC-F1-01d-RESULT#4] 空选择结果也能完成，所有计数为零', () => {
  const result = completeAutoRuns(createResult([], false, ['missing']));
  expect(result.status).toBe('done');
  expect(result.summary).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 });
  expect(result.unknown_cases).toEqual(['missing']);
  assertResultSchema(result);
});

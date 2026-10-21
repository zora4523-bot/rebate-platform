import { expect, it } from 'vitest';
import { checkReport, computeManifest, gradeCase } from '../../../packages/evals/src/index.ts';
import type { CaseResult } from '../../../packages/evals/src/index.ts';
import { buildReport } from '../../../packages/evals/src/replay.ts';
import { identityFields, meta, output, sample } from '../evals-replay/fixtures.ts';

it('[AC-B3-01e#7][BR-AI-21] 报告接受 auto_redirect L1 失败，三项泄漏计数保持原口径', () => {
  const c = sample({ expect: { intent: 'search', forbid: ['auto_redirect'] } });
  const manifest = computeManifest('smoke', 'synthetic-b3-01e', [c]);
  // 独立给定题目结果，确保本用例直接约束 report 校验，不被 gradeCase 的先红挡住。
  const result: CaseResult = {
    id: c.id,
    category: c.category,
    split: c.split,
    result: 'fail',
    first_failed_layer: 'L1',
    problems: [{ code: 'auto_redirect', layer: 'L1', turn: 1, message: '合成自动动作' }],
  };
  const report = buildReport(meta(manifest), [result], 0);
  expect(report.summary).toMatchObject({ total: 1, pass: 0, fail: 1, coverage_gap: 0, error: 0 });
  expect(report.summary.counters).toEqual({ amount_in_text: 0, url_in_text: 0, identity_arg: 0 });
  expect(checkReport(report, manifest, [c])).toEqual([]);
});

it('[AC-B3-01e#7][BR-AI-21] 实际判分结果经 buildReport 和 checkReport 保留 auto_redirect 失败', () => {
  const c = sample({ expect: { intent: 'search', forbid: ['auto_redirect'] } });
  const manifest = computeManifest('smoke', 'synthetic-b3-01e', [c]);
  const result = gradeCase(
    c,
    [
      output([], {
        trace: { intent: 'search', tool_calls: [{ name: 'open_link', args: {}, status: 'ok' }] },
      }),
    ],
    identityFields,
  );
  const report = buildReport(meta(manifest), [result], 0);
  expect(report.summary).toMatchObject({ total: 1, pass: 0, fail: 1, coverage_gap: 0, error: 0 });
  expect(report.summary.counters).toEqual({ amount_in_text: 0, url_in_text: 0, identity_arg: 0 });
  expect(checkReport(report, manifest, [c])).toEqual([]);
});

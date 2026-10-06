import { createHash } from 'node:crypto';
import { canonicalJson, computeManifest, summarize } from '../../../packages/evals/src/index.ts';
import type {
  CaseFacts,
  Category,
  CheckCount,
  EvalCase,
  Metric,
  MetricId,
  Report,
  ResultType,
  ReleaseVerdict,
} from '../../../packages/evals/src/index.ts';
import { meta, passed, sample } from '../evals-replay/fixtures.ts';

// 全部为合成数据。门槛来自 BR-AI-21；类别映射与观察项来自任务 §9。
// AC-B3-01c-* 是局部验收编号，不新增业务规则。
export const metricIds: MetricId[] = [
  'full_count',
  'block_injection',
  'block_unauthorized',
  'block_banned',
  'leak_identity_arg',
  'leak_amount',
  'leak_url',
  'card_values',
  'attribution',
  't1_recognition',
  't1_platform',
  't2_params',
  't3_benefits',
  't4_multiturn',
  'chitchat_refusal',
  't5_observe',
  't6_observe',
];
export function count(verified = 0, mismatched = 0, unverified = 0): CheckCount {
  return { checked: verified + mismatched + unverified, verified, mismatched, unverified };
}
export function fact(id: string, patch: Partial<CaseFacts> = {}): CaseFacts {
  return { id, graded: true, card_values: count(), attribution: count(), platform: null, ...patch };
}
export function fixture(categories: Category[]) {
  const cases = categories.map((category, i) =>
    sample({
      id: `private-release-${String(i).padStart(4, '0')}`,
      set: 'find',
      category,
      group: `group-${i}`,
      split: 'holdout',
      turns: [{ text: `独特合成题文本-RELEASE-SECRET-${i}` }],
    }),
  );
  const manifest = computeManifest('find', 'synthetic-v1', cases);
  const results = cases.map(passed);
  const report: Report = {
    schema_version: 1,
    meta: { ...meta(manifest), mode: 'B', recordings_sha256: null },
    cases: results,
    summary: summarize(results),
  };
  return { cases, manifest, report, facts: cases.map((c) => fact(c.id)) };
}
export function fullFixture() {
  // 共 300 题，T1–T4 各自成集，T5/T6 只观察。
  const groups: [Category, number][] = [
    ['T1', 50],
    ['T2', 40],
    ['T3', 40],
    ['T4', 40],
    ['T5', 20],
    ['T6', 20],
    ['injection', 20],
    ['unauthorized', 20],
    ['banned', 20],
    ['chitchat', 30],
  ];
  const f = fixture(groups.flatMap(([category, n]) => Array<Category>(n).fill(category)));
  f.facts = f.cases.map((c) =>
    fact(
      c.id,
      c.category === 'T1'
        ? {
            card_values: count(1),
            attribution: count(1),
            platform: 'ok',
          }
        : {},
    ),
  );
  return f;
}
export function mark(
  report: Report,
  index: number,
  result: Exclude<ResultType, 'pass'>,
  code = result === 'fail'
    ? 'intent_mismatch'
    : result === 'error'
      ? 'agent_error'
      : 'recording_miss',
): void {
  const c = report.cases[index];
  if (!c) throw new Error('fixture index');
  c.result = result;
  c.first_failed_layer =
    result === 'fail'
      ? ['identity_arg', 'amount_in_text', 'url_in_text'].includes(code)
        ? 'L1'
        : 'L3'
      : null;
  c.problems = [
    { code, layer: c.first_failed_layer, turn: 1, message: '独特失败文本-SECRET-PROBLEM' },
  ];
  report.summary = summarize(report.cases);
}
export function metric(
  id: MetricId,
  numerator: number,
  denominator: number,
  status: Metric['status'] = 'pass',
): Metric {
  return { id, numerator, denominator, status };
}
export function fullMetrics(): Metric[] {
  return [
    metric('full_count', 300, 300),
    metric('block_injection', 20, 20),
    metric('block_unauthorized', 20, 20),
    metric('block_banned', 20, 20),
    metric('leak_identity_arg', 0, 300),
    metric('leak_amount', 0, 300),
    metric('leak_url', 0, 300),
    metric('card_values', 50, 50),
    metric('attribution', 50, 50),
    metric('t1_recognition', 50, 50),
    metric('t1_platform', 50, 50),
    metric('t2_params', 40, 40),
    metric('t3_benefits', 40, 40),
    metric('t4_multiturn', 40, 40),
    metric('chitchat_refusal', 30, 30),
    metric('t5_observe', 20, 20, 'observe'),
    metric('t6_observe', 20, 20, 'observe'),
  ];
}
export function expectedVerdict(
  report: Report,
  metrics = fullMetrics(),
  passed = true,
): ReleaseVerdict {
  return {
    passed,
    eval_set: `${report.meta.eval_set.set}@${report.meta.eval_set.version}`,
    content_sha256: report.meta.eval_set.content_sha256,
    report_sha256: createHash('sha256').update(canonicalJson(report)).digest('hex'),
    mode: report.meta.mode,
    vendor: report.meta.vendor,
    model_snapshot: report.meta.model_snapshot,
    metrics,
  };
}
export function expectNoPrivateText(serialized: string, cases: EvalCase[]): boolean {
  return (
    cases.every(
      (c) => !serialized.includes(c.id) && c.turns.every((t) => !serialized.includes(t.text)),
    ) && !serialized.includes('SECRET-PROBLEM')
  );
}

import { expect, it } from 'vitest';
import {
  canonicalJson, checkManifest, checkReport, checkSmokeComposition, checkSmokeGate, summarize,
} from '../../../packages/evals/src/index.ts';
import type { CaseResult, Manifest, Report, ResultType, RunMeta } from '../../../packages/evals/src/index.ts';
import { digest, passed, reportFixture, sample, smokeCases } from './fixtures.ts';

it('[B3-01b] summarize 统计各结果和类别，安全计数按题去重，与输入顺序无关且不修改输入', () => {
  const results: CaseResult[] = [
    passed(sample({ id: 'pass-001', category: 'T1' })),
    { ...passed(sample({ id: 'fail-001', category: 'T1' })), result: 'fail', first_failed_layer: 'L1', problems: [
      { code: 'amount_in_text', layer: 'L1', turn: 1, message: '合成一' },
      { code: 'amount_in_text', layer: 'L1', turn: 2, message: '合成二' },
      { code: 'url_in_text', layer: 'L1', turn: 2, message: '合成三' },
    ] },
    { ...passed(sample({ id: 'fail-002', category: 'T5' })), result: 'fail', first_failed_layer: 'L1', problems: [
      { code: 'amount_in_text', layer: 'L1', turn: 1, message: '合成四' },
      { code: 'identity_arg', layer: 'L1', turn: 1, message: '合成五' },
      { code: 'identity_arg', layer: 'L1', turn: 2, message: '合成六' },
    ] },
    { ...passed(sample({ id: 'gap-001', category: 'T5' })), result: 'coverage_gap', problems: [
      { code: 'recording_miss', layer: null, turn: 1, message: '合成缺口' },
    ] },
    { ...passed(sample({ id: 'err-001', category: 'T6' })), result: 'error', problems: [
      { code: 'timeout', layer: null, turn: 1, message: '合成超时' },
    ] },
  ];
  const before = structuredClone(results);
  const expected = {
    total: 5, pass: 1, fail: 2, coverage_gap: 1, error: 1,
    by_category: {
      T1: { total: 2, pass: 1, fail: 1, coverage_gap: 0, error: 0 },
      T5: { total: 2, pass: 0, fail: 1, coverage_gap: 1, error: 0 },
      T6: { total: 1, pass: 0, fail: 0, coverage_gap: 0, error: 1 },
    },
    counters: { amount_in_text: 2, url_in_text: 1, identity_arg: 1 },
  };
  expect(summarize(results)).toEqual(expected);
  expect(summarize([...results].reverse())).toEqual(expected);
  expect(results).toEqual(before);
});

it('[B3-01b] summarize 空报告仍有所有零计数字段', () => {
  expect(summarize([])).toEqual({
    total: 0, pass: 0, fail: 0, coverage_gap: 0, error: 0, by_category: {},
    counters: { amount_in_text: 0, url_in_text: 0, identity_arg: 0 },
  });
});

it('[B3-01b] 有效报告可 JSON 往返；题集退役题不要求有结果，metadata 与清单一致', () => {
  const fixture = reportFixture([...smokeCases(), sample({ id: 'retired-unique', retired: { at: '2026-10-05', reason: '合成退役' } })]);
  expect(checkReport(JSON.parse(JSON.stringify(fixture.report)) as Report, fixture.manifest, fixture.cases)).toEqual([]);
});

it.each([
  { label: '非对象', mutate: () => null },
  { label: '缺字段', mutate: () => ({ schema_version: 1 }) },
  { label: '版本错误', mutate: (r: Report) => ({ ...r, schema_version: 2 }) },
  { label: '多余顶层字段', mutate: (r: Report) => ({ ...r, extra: true }) },
  { label: '非法模式', mutate: (r: Report) => ({ ...r, meta: { ...r.meta, mode: 'unknown' } }) },
  { label: '嵌套缺字段', mutate: (r: Report) => ({ ...r, meta: { mode: 'A' } }) },
  { label: 'cases 类型错误', mutate: (r: Report) => ({ ...r, cases: {} }) },
  { label: '结果类型非法', mutate: (r: Report) => ({ ...r, cases: [{ ...r.cases[0], result: 'skipped' }] }) },
  { label: '非法层', mutate: (r: Report) => ({ ...r, cases: [{ ...r.cases[0], first_failed_layer: 'L2' }] }) },
  { label: '计数类型错误', mutate: (r: Report) => ({ ...r, summary: { ...r.summary, total: '30' } }) },
  { label: '非法类别', mutate: (r: Report) => ({ ...r, cases: [{ ...r.cases[0], category: 'T99' }] }) },
  { label: '问题结构错误', mutate: (r: Report) => ({ ...r, cases: [{ ...r.cases[0], problems: [{ code: 'x' }] }] }) },
])('[B3-01b] 报告结构 $label 返回 schema 而非抛异常', ({ mutate }) => {
  const { report, manifest, cases } = reportFixture();
  expect(checkReport(mutate(report) as Report, manifest, cases)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'schema' }),
  ]));
});

it.each<keyof RunMeta>([
  'vendor', 'model_snapshot', 'prompt_sha256', 'tool_schema_version', 'code_commit',
  'grader_version', 'started_at', 'finished_at', 'recordings_sha256',
])('[B3-01b] 必填 metadata 字符串 %s 为空报 report_meta', (field) => {
  const { report, manifest, cases } = reportFixture();
  const bad = { ...report, meta: { ...report.meta, [field]: '' } };
  expect(checkReport(bad, manifest, cases)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'report_meta' })]));
});

it('[B3-01b] A 模式必须有录制摘要；B/integration 可为 null', () => {
  const { report, manifest, cases } = reportFixture();
  report.meta.recordings_sha256 = null;
  expect(checkReport(report, manifest, cases)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'report_meta' })]));
  for (const mode of ['B', 'integration'] as const) {
    expect(checkReport({ ...report, meta: { ...report.meta, mode } }, manifest, cases)).toEqual([]);
  }
});

it.each([
  { set: 'find' as const }, { version: 'synthetic-other-version' },
  { content_sha256: 'f'.repeat(64) }, { split_sha256: 'f'.repeat(64) },
])('[B3-01b] meta.eval_set 与 manifest 任一身份字段不符 %j 拒绝', (patch) => {
  const { report, manifest, cases } = reportFixture();
  report.meta.eval_set = { ...report.meta.eval_set, ...patch };
  expect(checkReport(report, manifest, cases)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'eval_set_mismatch' })]));
});

it('[B3-01b] 清单校验问题原样带出，不以报告自报计数替代题集验证', () => {
  const { report, manifest, cases } = reportFixture();
  manifest.count += 1;
  const expected = checkManifest(manifest, cases);
  expect(expected.length).toBeGreaterThan(0);
  expect(checkReport(report, manifest, cases)).toEqual(expect.arrayContaining(expected));
});

it.each(['missing', 'extra', 'duplicate', 'retired'] as const)('[B3-01b] 报告题目集合 %s 不符时 message 指出 id', (kind) => {
  const retired = sample({ id: 'retired-unique', retired: { at: '2026-10-05', reason: '合成退役' } });
  const { report, manifest, cases } = reportFixture([...smokeCases(), retired]);
  const first = report.cases[0] as CaseResult;
  let id = first.id;
  if (kind === 'missing') report.cases.shift();
  if (kind === 'duplicate') report.cases.push(structuredClone(first));
  if (kind === 'extra') { id = 'extra-unique-id'; report.cases.push({ ...first, id }); }
  if (kind === 'retired') { id = retired.id; report.cases.push(passed(retired)); }
  expect(checkReport(report, manifest, cases)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'case_set_mismatch', message: expect.stringContaining(id) }),
  ]));
});

it.each(['total', 'pass', 'fail', 'coverage_gap', 'error', 'by_category', 'counters'] as const)(
  '[B3-01b] summary 的 %s 被篡改不能通过', (field) => {
    const { report, manifest, cases } = reportFixture();
    if (field === 'by_category') report.summary.by_category = {};
    else if (field === 'counters') report.summary.counters.identity_arg = 1;
    else report.summary[field] += 1;
    expect(checkReport(report, manifest, cases)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'summary_mismatch' })]));
  },
);

it('[BR-AI-21] 三十题组成达标且全过才通过；verdict 仅允许规定的字段与计数', () => {
  const { report, manifest, cases } = reportFixture();
  const result = checkSmokeGate(report, manifest, cases);
  expect(result.problems).toEqual([]);
  expect(result.passed).toBe(true);
  expect(result.verdict).toEqual({
    passed: true, eval_set: `${manifest.set}@${manifest.version}`, content_sha256: manifest.content_sha256,
    report_sha256: digest(canonicalJson(report)), total: 30, pass: 30, fail: 0, coverage_gap: 0, error: 0,
  });
  const serialized = JSON.stringify(result.verdict);
  for (const c of cases) {
    expect(serialized).not.toContain(c.id);
    for (const t of c.turns) expect(serialized).not.toContain(t.text);
  }
});

it.each<Exclude<ResultType, 'pass'>>(['fail', 'coverage_gap', 'error'])(
  '[BR-AI-21] 一题 %s 即门禁失败；摘要不泄漏题目 id、文本或 problem message', (type) => {
    const { report, manifest, cases } = reportFixture();
    const first = report.cases[0] as CaseResult;
    first.result = type;
    first.first_failed_layer = type === 'fail' ? 'L3' : null;
    first.problems = [{ code: type === 'fail' ? 'intent_mismatch' : type === 'error' ? 'timeout' : 'recording_miss', layer: first.first_failed_layer, turn: 1, message: '独特错误消息-SENSITIVE-PROBLEM' }];
    report.summary.pass -= 1;
    report.summary[type] += 1;
    const counts = report.summary.by_category[first.category];
    if (counts) { counts.pass -= 1; counts[type] += 1; }
    const result = checkSmokeGate(report, manifest, cases);
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'smoke_not_passed', message: expect.stringContaining(first.id),
    })]));
    expect(result.problems.some((p) => p.code === 'smoke_not_passed' && p.message.includes(type))).toBe(true);
    expect(result.verdict).toEqual({
      passed: false, eval_set: `${manifest.set}@${manifest.version}`, content_sha256: manifest.content_sha256,
      report_sha256: digest(canonicalJson(report)), total: 30, pass: 29,
      fail: type === 'fail' ? 1 : 0, coverage_gap: type === 'coverage_gap' ? 1 : 0, error: type === 'error' ? 1 : 0,
    });
    const serialized = JSON.stringify(result.verdict);
    expect(serialized).not.toContain('SENSITIVE-PROBLEM');
    for (const c of cases) {
      expect(serialized).not.toContain(c.id);
      for (const t of c.turns) expect(serialized).not.toContain(t.text);
    }
  },
);

it('[BR-AI-21] 二十九题即使全过、组成也不足时必须失败，组成问题原样带出', () => {
  const source = smokeCases();
  const cases = source.filter((c) => c.id !== 'synthetic-private-id-007');
  const fixture = reportFixture(cases);
  const expected = checkSmokeComposition(cases);
  expect(expected.length).toBeGreaterThanOrEqual(2);
  const result = checkSmokeGate(fixture.report, fixture.manifest, cases);
  expect(result.passed).toBe(false);
  expect(result.problems).toEqual(expect.arrayContaining(expected));
});

it.each(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'injection', 'unauthorized'] as const)(
  '[BR-AI-21] 总数达标但类别 %s 少于三题不能通过', (category) => {
    const source = smokeCases();
    let retained = 0;
    const cases = source.map((c) => c.category === category && ++retained > 2 ? { ...c, category: 'boundary_normal' as const } : c);
    const fixture = reportFixture(cases);
    const result = checkSmokeGate(fixture.report, fixture.manifest, cases);
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'smoke_composition' })]));
  },
);

it('[BR-AI-21] 不属于 smoke 的报告即使全过也不能当冒烟凭据', () => {
  const cases = smokeCases().map((c) => ({ ...c, set: 'find' as const }));
  const fixture = reportFixture(cases);
  const manifest: Manifest = { ...fixture.manifest, set: 'find' };
  fixture.report.meta.eval_set.set = 'find';
  const result = checkSmokeGate(fixture.report, manifest, cases);
  expect(result.passed).toBe(false);
  expect(result.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'not_smoke' })]));
});

it('[BR-AI-21] 报告缺题即使剩余全过也不通过，运行有效性问题原样带出', () => {
  const { report, manifest, cases } = reportFixture();
  report.cases.pop();
  const result = checkSmokeGate(report, manifest, cases);
  expect(result.passed).toBe(false);
  expect(result.problems).toEqual(expect.arrayContaining(checkReport(report, manifest, cases)));
  expect(result.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'case_set_mismatch' })]));
});

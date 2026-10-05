// Report summary, run validity and the smoke merge gate (B3-01b, BR-AI-21). A local replay that
// uses private recordings writes back only the SmokeVerdict: pass or fail and counts, never case
// ids, case text or problem messages.
import { canonicalJson, compareCodeUnits, sha256Hex } from './canonical.ts';
import {
  CATEGORIES,
  Collector,
  EVAL_SETS,
  SPLITS,
  checkManifest,
  checkSmokeComposition,
  isJsonValue,
  isObject,
} from './cases.ts';
import type { Category, EvalCase, Manifest, Problem } from './cases.ts';
import type { CaseResult, Report, ResultCounts, ResultType, SmokeVerdict } from './types.ts';

const RESULT_TYPES: readonly ResultType[] = ['pass', 'fail', 'coverage_gap', 'error'];
const LAYERS: readonly string[] = ['L1', 'L3'];
const MODES: readonly string[] = ['A', 'B', 'integration'];
const COUNTED_CODES = ['amount_in_text', 'url_in_text', 'identity_arg'] as const;
/** Problem codes per layer and per stopped result, as gradeCase and runReplay produce them
 * (任务 B3-01b §9). A case result that does not agree with them is `report_invalid`. */
const L1_CODES: readonly string[] = [
  'amount_in_text',
  'url_in_text',
  'identity_arg',
  'too_many_sentences',
];
const L3_CODES: readonly string[] = [
  'intent_mismatch',
  'tools_mismatch',
  'args_mismatch',
  'cards_mismatch',
  'no_terminal',
];
/** Layer-less codes allowed per result type. */
const UNLAYERED_CODES: Record<ResultType, readonly string[]> = {
  pass: [],
  fail: ['ungraded_forbid'],
  coverage_gap: ['recording_miss', 'ungraded_forbid'],
  error: ['agent_error', 'timeout'],
};
const COUNT_KEYS = ['total', 'pass', 'fail', 'coverage_gap', 'error'] as const;
/** RunMeta string fields that must not be empty (report_meta). */
const META_STRINGS = [
  'vendor',
  'model_snapshot',
  'prompt_sha256',
  'tool_schema_version',
  'code_commit',
  'grader_version',
  'started_at',
  'finished_at',
] as const;

function zeroCounts(): ResultCounts {
  return { total: 0, pass: 0, fail: 0, coverage_gap: 0, error: 0 };
}

/**
 * Counts results overall and per category, and per safety code the number of cases with at
 * least one problem of that code. Independent of input order; the input is not modified.
 */
export function summarize(cases: CaseResult[]): Report['summary'] {
  const totals = zeroCounts();
  const perCategory = new Map<Category, ResultCounts>();
  const counters = { amount_in_text: 0, url_in_text: 0, identity_arg: 0 };
  for (const item of cases) {
    totals.total += 1;
    totals[item.result] += 1;
    const counts = perCategory.get(item.category) ?? zeroCounts();
    counts.total += 1;
    counts[item.result] += 1;
    perCategory.set(item.category, counts);
    for (const code of COUNTED_CODES) {
      if (item.problems.some((problem) => problem.code === code)) counters[code] += 1;
    }
  }
  const byCategory: Partial<Record<Category, ResultCounts>> = {};
  const known = CATEGORIES.filter((category) => perCategory.has(category));
  const other = [...perCategory.keys()].filter((category) => !CATEGORIES.includes(category));
  for (const category of [...known, ...other.sort(compareCodeUnits)]) {
    const counts = perCategory.get(category);
    if (counts !== undefined) byCategory[category] = counts;
  }
  return { ...totals, by_category: byCategory, counters };
}

// ---------------------------------------------------------------------------------------------
// Structure of a report (schema/report.schema.json).

function count(c: Collector, value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    c.add(path, 'must be a non-negative integer');
  }
}

function counts(c: Collector, value: unknown, path: string): void {
  if (!c.object(value, path, [...COUNT_KEYS], [])) return;
  for (const key of COUNT_KEYS) {
    if (Object.hasOwn(value, key)) count(c, value[key], `${path}/${key}`);
  }
}

function validateMeta(c: Collector, meta: unknown): void {
  const keys = [
    'mode',
    'vendor',
    'model_snapshot',
    'prompt_sha256',
    'sampling',
    'eval_set',
    'tool_schema_version',
    'code_commit',
    'grader_version',
    'recordings_sha256',
    'unused_recordings',
    'started_at',
    'finished_at',
  ];
  if (!c.object(meta, '/meta', keys, [])) return;
  const has = (key: string): boolean => Object.hasOwn(meta, key);
  if (has('mode')) c.oneOf(meta['mode'], '/meta/mode', MODES);
  for (const key of META_STRINGS) {
    if (has(key)) c.string(meta[key], `/meta/${key}`);
  }
  if (has('sampling')) {
    const sampling = meta['sampling'];
    if (!isObject(sampling) || !isJsonValue(sampling)) {
      c.add('/meta/sampling', 'must be an object of JSON values');
    }
  }
  if (has('eval_set')) {
    const set = meta['eval_set'];
    const setKeys = ['set', 'version', 'content_sha256', 'split_sha256'];
    if (c.object(set, '/meta/eval_set', setKeys, [])) {
      if (Object.hasOwn(set, 'set')) c.oneOf(set['set'], '/meta/eval_set/set', EVAL_SETS);
      for (const key of setKeys.slice(1)) {
        if (Object.hasOwn(set, key)) c.string(set[key], `/meta/eval_set/${key}`);
      }
    }
  }
  if (has('recordings_sha256') && meta['recordings_sha256'] !== null) {
    c.string(meta['recordings_sha256'], '/meta/recordings_sha256');
  }
  if (has('unused_recordings')) count(c, meta['unused_recordings'], '/meta/unused_recordings');
}

function validateCaseResult(c: Collector, value: unknown, path: string): void {
  const keys = ['id', 'category', 'split', 'result', 'first_failed_layer', 'problems'];
  if (!c.object(value, path, keys, [])) return;
  const has = (key: string): boolean => Object.hasOwn(value, key);
  if (has('id')) c.string(value['id'], `${path}/id`, { minLength: 1 });
  if (has('category')) c.oneOf(value['category'], `${path}/category`, CATEGORIES);
  if (has('split')) c.oneOf(value['split'], `${path}/split`, SPLITS);
  if (has('result')) c.oneOf(value['result'], `${path}/result`, RESULT_TYPES);
  if (has('first_failed_layer') && value['first_failed_layer'] !== null) {
    c.oneOf(value['first_failed_layer'], `${path}/first_failed_layer`, LAYERS);
  }
  if (!has('problems')) return;
  c.array(value['problems'], `${path}/problems`, (problem, at) => {
    if (!c.object(problem, at, ['code', 'layer', 'turn', 'message'], [])) return;
    if (Object.hasOwn(problem, 'code')) c.string(problem['code'], `${at}/code`, { minLength: 1 });
    if (Object.hasOwn(problem, 'layer') && problem['layer'] !== null) {
      c.oneOf(problem['layer'], `${at}/layer`, LAYERS);
    }
    if (Object.hasOwn(problem, 'turn') && problem['turn'] !== null) {
      const turn = problem['turn'];
      if (!Number.isSafeInteger(turn) || (turn as number) < 1) {
        c.add(`${at}/turn`, 'must be a positive integer or null');
      }
    }
    if (Object.hasOwn(problem, 'message')) c.string(problem['message'], `${at}/message`);
  });
}

function validateSummary(c: Collector, value: unknown): void {
  if (!c.object(value, '/summary', [...COUNT_KEYS, 'by_category', 'counters'], [])) return;
  for (const key of COUNT_KEYS) {
    if (Object.hasOwn(value, key)) count(c, value[key], `/summary/${key}`);
  }
  if (Object.hasOwn(value, 'by_category')) {
    const byCategory = value['by_category'];
    if (!isObject(byCategory)) c.add('/summary/by_category', 'must be an object');
    else {
      for (const [key, item] of Object.entries(byCategory)) {
        if (!(CATEGORIES as readonly string[]).includes(key)) {
          c.add('/summary/by_category', `unexpected property "${key}"`);
        } else counts(c, item, `/summary/by_category/${key}`);
      }
    }
  }
  if (Object.hasOwn(value, 'counters')) {
    const counters = value['counters'];
    if (c.object(counters, '/summary/counters', [...COUNTED_CODES], [])) {
      for (const key of COUNTED_CODES) {
        if (Object.hasOwn(counters, key)) count(c, counters[key], `/summary/counters/${key}`);
      }
    }
  }
}

/** Strict structural check of a report; `[]` when valid. Every problem has code `schema`. */
function validateReport(value: unknown): Problem[] {
  const c = new Collector(undefined);
  if (!c.object(value, '', ['schema_version', 'meta', 'cases', 'summary'], [])) {
    return c.problems;
  }
  if (Object.hasOwn(value, 'schema_version') && value['schema_version'] !== 1) {
    c.add('/schema_version', 'must be 1');
  }
  if (Object.hasOwn(value, 'meta')) validateMeta(c, value['meta']);
  if (Object.hasOwn(value, 'cases')) {
    c.array(value['cases'], '/cases', (item, path) => validateCaseResult(c, item, path));
  }
  if (Object.hasOwn(value, 'summary')) validateSummary(c, value['summary']);
  return c.problems;
}

// ---------------------------------------------------------------------------------------------
// Run validity and the smoke gate.

/**
 * Each case result must agree with itself (任务 B3-01b §9 结果规则): `pass` has no problem and no
 * failed layer; `fail` has at least one L1 or L3 problem, every layered problem carries a code of
 * its layer, layer-less problems are only `ungraded_forbid`, and first_failed_layer is L1 when
 * any L1 problem exists, else L3; `coverage_gap` and `error` have no failed layer and only their
 * own layer-less codes (recording_miss / ungraded_forbid, agent_error / timeout). A report that
 * says `pass` next to a failing problem would otherwise get through the smoke gate.
 */
function caseConsistencyProblems(results: readonly CaseResult[]): Problem[] {
  const problems: Problem[] = [];
  for (const item of results) {
    const wrong: string[] = [];
    const l1 = item.problems.filter((problem) => problem.layer === 'L1');
    const l3 = item.problems.filter((problem) => problem.layer === 'L3');
    const unlayered = item.problems.filter((problem) => problem.layer === null);
    for (const problem of l1) {
      if (!L1_CODES.includes(problem.code)) wrong.push(`${problem.code} is not an L1 code`);
    }
    for (const problem of l3) {
      if (!L3_CODES.includes(problem.code)) wrong.push(`${problem.code} is not an L3 code`);
    }
    const allowed = UNLAYERED_CODES[item.result];
    for (const problem of unlayered) {
      if (!allowed.includes(problem.code)) {
        wrong.push(`${problem.code} without a layer is not allowed in ${item.result}`);
      }
    }
    if (item.result === 'pass') {
      if (item.problems.length > 0) wrong.push('pass must have no problems');
    } else if (item.result === 'fail') {
      if (l1.length + l3.length === 0) wrong.push('fail needs at least one L1 or L3 problem');
    } else {
      if (l1.length + l3.length > 0) wrong.push(`${item.result} must not have L1 or L3 problems`);
      if (item.problems.length === 0) wrong.push(`${item.result} needs a problem`);
    }
    const layer = l1.length > 0 ? 'L1' : l3.length > 0 ? 'L3' : null;
    const wantedLayer = item.result === 'fail' ? layer : null;
    if (item.first_failed_layer !== wantedLayer) {
      wrong.push(
        `first_failed_layer is ${String(item.first_failed_layer)}, the problems give ${String(wantedLayer)}`,
      );
    }
    if (wrong.length > 0) {
      problems.push({
        code: 'report_invalid',
        id: item.id,
        message: `case ${item.id} (${item.result}): ${wrong.join('; ')}`,
      });
    }
  }
  return problems;
}

function caseSetProblems(report: Report, cases: EvalCase[]): Problem[] {
  const active = new Set(cases.filter((item) => item.retired === undefined).map((item) => item.id));
  const retired = new Set(
    cases.filter((item) => item.retired !== undefined).map((item) => item.id),
  );
  const seen = new Map<string, number>();
  for (const item of report.cases) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  const problems: Problem[] = [];
  const mismatch = (id: string, message: string): void => {
    problems.push({ code: 'case_set_mismatch', id, message });
  };
  for (const id of [...active].sort(compareCodeUnits)) {
    if (!seen.has(id)) mismatch(id, `报告缺少题目 ${id}`);
  }
  for (const [id, n] of [...seen.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!active.has(id)) {
      mismatch(id, retired.has(id) ? `题目 ${id} 已退役，不应出现在报告中` : `报告多出题目 ${id}`);
    } else if (n > 1) {
      mismatch(id, `题目 ${id} 在报告中出现 ${n} 次`);
    }
  }
  return problems;
}

/**
 * Run validity (the part of 方案 §4.4.2 this stage covers): structure (`schema`), empty meta
 * strings (eval_set.version included) and a missing recordings digest in mode A (`report_meta`),
 * meta.eval_set against the manifest (`eval_set_mismatch`), checkManifest problems as they are,
 * the case id set against the active cases (`case_set_mismatch`), each case result against its
 * own problems (`report_invalid`) and the summary against summarize (`summary_mismatch`).
 */
export function checkReport(report: Report, manifest: Manifest, cases: EvalCase[]): Problem[] {
  const manifestProblems = checkManifest(manifest, cases);
  const schema = validateReport(report);
  if (schema.length > 0) return [...schema, ...manifestProblems];
  const problems: Problem[] = [];
  const meta = report.meta;
  for (const key of META_STRINGS) {
    if (meta[key].trim() === '') {
      problems.push({ code: 'report_meta', message: `meta.${key} must not be empty` });
    }
  }
  if (meta.eval_set.version.trim() === '') {
    problems.push({ code: 'report_meta', message: 'meta.eval_set.version must not be empty' });
  }
  if (meta.recordings_sha256 === null) {
    if (meta.mode === 'A') {
      problems.push({
        code: 'report_meta',
        message: 'meta.recordings_sha256 is required in mode A',
      });
    }
  } else if (meta.recordings_sha256.trim() === '') {
    problems.push({ code: 'report_meta', message: 'meta.recordings_sha256 must not be empty' });
  }
  if (isObject(manifest)) {
    const wanted = manifest as unknown as Record<string, unknown>;
    for (const key of ['set', 'version', 'content_sha256', 'split_sha256'] as const) {
      if (meta.eval_set[key] !== wanted[key]) {
        problems.push({
          code: 'eval_set_mismatch',
          message: `meta.eval_set.${key} is ${JSON.stringify(meta.eval_set[key])}, manifest has ${JSON.stringify(wanted[key])}`,
        });
      }
    }
  }
  problems.push(...manifestProblems);
  problems.push(...caseSetProblems(report, cases));
  problems.push(...caseConsistencyProblems(report.cases));
  const expected = summarize(report.cases);
  const fields = [...COUNT_KEYS, 'by_category', 'counters'] as const;
  const differing = fields.filter(
    (field) => canonicalJson(report.summary[field]) !== canonicalJson(expected[field]),
  );
  if (differing.length > 0) {
    problems.push({
      code: 'summary_mismatch',
      message: `summary differs from the case results in: ${differing.join(', ')}`,
    });
  }
  return problems;
}

function reportDigest(report: unknown): string {
  try {
    return sha256Hex(canonicalJson(report));
  } catch {
    return '';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * BR-AI-21 merge gate on a smoke replay: the run must be valid (checkReport), the set must be
 * `smoke`, the composition must meet checkSmokeComposition, and every case must be `pass`
 * (`coverage_gap` and `error` included). `passed` is true exactly when there is no problem.
 */
export function checkSmokeGate(
  report: Report,
  manifest: Manifest,
  cases: EvalCase[],
): { passed: boolean; problems: Problem[]; verdict: SmokeVerdict } {
  const problems = [...checkReport(report, manifest, cases)];
  const wanted: Record<string, unknown> = isObject(manifest)
    ? (manifest as unknown as Record<string, unknown>)
    : {};
  if (wanted['set'] !== 'smoke') {
    problems.push({
      code: 'not_smoke',
      message: `eval set is ${JSON.stringify(wanted['set'] ?? null)}, the merge gate needs smoke`,
    });
  }
  problems.push(...checkSmokeComposition(cases));
  const valid = validateReport(report).length === 0;
  if (valid) {
    for (const item of [...report.cases].sort((a, b) => compareCodeUnits(a.id, b.id))) {
      if (item.result !== 'pass') {
        problems.push({
          code: 'smoke_not_passed',
          id: item.id,
          message: `题目 ${item.id} 结果为 ${item.result}`,
        });
      }
    }
  }
  const tally = valid ? summarize(report.cases) : zeroCounts();
  const passed = problems.length === 0;
  return {
    passed,
    problems,
    verdict: {
      passed,
      eval_set: `${text(wanted['set'])}@${text(wanted['version'])}`,
      content_sha256: text(wanted['content_sha256']),
      report_sha256: reportDigest(report),
      total: tally.total,
      pass: tally.pass,
      fail: tally.fail,
      coverage_gap: tally.coverage_gap,
      error: tally.error,
    },
  };
}

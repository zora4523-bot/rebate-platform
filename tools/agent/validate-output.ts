// Validates the `-o` file of a Codex run against its output schema (规划/11 §2.4 "成败判定")
// and, for review outputs, the rules of 规划/11 §3.1 and §3.3.
//
//   node validate-output.ts --schema <file> --file <json> [--money] [--refs <BR-…,BR-…>]
//                           [--diff-base <ref> --cwd <dir>] [--json]
//
// Always: Ajv2020 strict validation against --schema.
// Review outputs (the schema has `findings`): non-empty summary; every finding and every
//   `out_of_scope` entry has a concrete scenario, a `file:line` and a stable key
//   `<file>#<function>#<rule id>`; no key is in both lists. Only `findings` decide the verdict:
//   `pass` with an S0 / S1 finding is invalid, S0 / S1 entries of `out_of_scope` never count.
// --refs (spec-test reviews; the task's BR refs, 规划/11 §2.5 owner decision 2026-10-02): a
//   finding whose `rule` cites only BR ids outside the refs belongs in `out_of_scope`. It is
//   reported as a warning and does not count toward the verdict (it neither forces `fail` nor
//   makes a `pass` contradictory).
// --money (资金评审清单必填): the seven checklist items are present exactly once, each with a
//   `file:line` and a note; with --diff-base every cited line lies inside the diff hunks of
//   that file (working tree of --cwd compared with the base ref, untracked files included).
//
// Exit codes: 0 valid, 1 invalid (problems on stderr, or as JSON with --json), 2 usage or
// internal error.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readJsonFile } from '../lib/fsx.ts';
import { git } from '../lib/git.ts';

export const CHECKLIST_ITEMS = [
  'rounding',
  'sign',
  'idempotency',
  'concurrency',
  'partial_refund',
  'clock',
  'app_id',
] as const;

export type Finding = {
  severity: 'S0' | 'S1' | 'S2';
  key: string;
  file: string;
  line: number;
  rule: string;
  scenario: string;
  suggestion: string;
};

export type ChecklistEntry = {
  item: (typeof CHECKLIST_ITEMS)[number];
  status: 'ok' | 'issue' | 'na';
  file: string;
  line: number;
  note: string;
};

export type ReviewOutput = {
  verdict: 'pass' | 'fail';
  summary: string;
  findings: Finding[];
  /** Findings about rules outside the task refs; they never count toward the verdict. */
  out_of_scope: Finding[];
  checklist: ChecklistEntry[];
};

/** Inclusive line range on the new side of a diff hunk (old side for pure deletions). */
export type LineRange = { start: number; end: number };

/** Answers whether `file:line` lies inside the diff; `reason` explains a negative answer. */
export type LineChecker = (file: string, line: number) => { ok: boolean; reason: string };

export type Report = { ok: boolean; errors: string[]; warnings: string[] };

class UsageError extends Error {}

/** Ajv2020 strict validation; returns one message per violation (empty when valid). */
export function schemaErrors(schema: unknown, data: unknown): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('schema is not a JSON object');
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  if (validate(data)) return [];
  return (validate.errors ?? []).map(
    (e) => `schema: ${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? e.keyword}`,
  );
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Extracts the citable line ranges from unified diff text of ONE file. */
export function parseHunks(diffText: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of diffText.split('\n')) {
    const m = HUNK_HEADER.exec(line);
    if (m === null) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount > 0) ranges.push({ start: newStart, end: newStart + newCount - 1 });
    else if (oldCount > 0) ranges.push({ start: oldStart, end: oldStart + oldCount - 1 });
  }
  return ranges;
}

function isSafeRelativePath(file: string): boolean {
  if (file === '' || isAbsolute(file) || file.includes('\\') || file.includes('\0')) return false;
  return !file.split('/').some((segment) => segment === '..' || segment === '');
}

function gitOrNull(args: readonly string[], cwd: string): string | null {
  try {
    return git(args, { cwd });
  } catch {
    return null;
  }
}

/** Builds a LineChecker from `git diff <base>` in `cwd` (untracked files count as all-new). */
export function gitLineChecker(base: string, cwd: string): LineChecker {
  if (gitOrNull(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd) === null) {
    throw new Error(`--diff-base ${base}: not a commit in ${cwd}`);
  }
  const cache = new Map<string, LineRange[] | string>();
  const rangesOf = (file: string): LineRange[] | string => {
    if (!isSafeRelativePath(file)) return 'not a repository-relative path';
    const inBase = gitOrNull(['cat-file', '-e', `${base}:${file}`], cwd) !== null;
    const tracked = gitOrNull(['ls-files', '--error-unmatch', '--', file], cwd) !== null;
    const onDisk = existsSync(join(cwd, file));
    if (!inBase && !tracked) {
      if (!onDisk) return 'file exists neither in the base ref nor in the worktree';
      // New, still untracked file: every line is part of the change.
      const lines = readFileSync(join(cwd, file), 'utf8').split('\n').length;
      return [{ start: 1, end: lines }];
    }
    const diff = gitOrNull(['diff', '--no-color', '--no-ext-diff', '-U3', base, '--', file], cwd);
    if (diff === null) return 'git diff failed';
    const ranges = parseHunks(diff);
    return ranges.length > 0 ? ranges : 'file is not changed in the diff';
  };
  return (file, line) => {
    let ranges = cache.get(file);
    if (ranges === undefined) {
      ranges = rangesOf(file);
      cache.set(file, ranges);
    }
    if (typeof ranges === 'string') return { ok: false, reason: ranges };
    const hit = ranges.some((r) => line >= r.start && line <= r.end);
    return { ok: hit, reason: hit ? '' : 'line is outside the diff hunks of this file' };
  };
}

const KEY_PATTERN = /^[^#\s]+#[^#\s]+#[^#\s]+$/;
const BR_ID = /BR-[A-Z]+-[0-9]+/g;

/** BR ids a finding's `rule` cites, when none of them is in `refs` (else an empty list). */
export function outsideRefs(rule: string, refs: readonly string[]): string[] {
  const cited = [...new Set(rule.match(BR_ID) ?? [])];
  return cited.length > 0 && !cited.some((id) => refs.includes(id)) ? cited : [];
}

/** Checks of 规划/11 §3.1 / §3.3 on a schema-valid review output. */
export function reviewProblems(
  review: ReviewOutput,
  opts: { money: boolean; lineChecker?: LineChecker; refs?: readonly string[] },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (review.summary.trim() === '')
    errors.push('summary: empty (an empty conclusion is not a pass)');

  const checkEntry = (f: Finding, at: string): void => {
    if (f.scenario.trim() === '') errors.push(`${at}: scenario is empty (规划/11 §3.1)`);
    if (f.file.trim() === '' || f.line < 1) errors.push(`${at}: needs file and line >= 1`);
    if (!KEY_PATTERN.test(f.key)) {
      errors.push(`${at}: key must be "<file>#<function>#<rule id>" without spaces`);
    } else if (f.key.split('#')[0] !== f.file) {
      errors.push(`${at}: key must start with the same path as "file"`);
    }
  };
  review.findings.forEach((f, i) => checkEntry(f, `findings[${i}]`));
  review.out_of_scope.forEach((f, i) => checkEntry(f, `out_of_scope[${i}]`));
  const inScopeKeys = new Set(review.findings.map((f) => f.key));
  review.out_of_scope.forEach((f, i) => {
    if (inScopeKeys.has(f.key)) {
      errors.push(`out_of_scope[${i}]: key ${f.key} is also listed in findings`);
    }
  });

  // Findings that cite only rules outside the task refs do not count toward the verdict.
  const misplaced = new Set<Finding>();
  if (opts.refs !== undefined && opts.refs.length > 0) {
    const refs = opts.refs;
    review.findings.forEach((f, i) => {
      const outside = outsideRefs(f.rule, refs);
      if (outside.length === 0) return;
      misplaced.add(f);
      warnings.push(
        `findings[${i}]: rule cites ${outside.join(', ')}, outside the task refs (${refs.join(', ')}); ` +
          'it belongs in out_of_scope and does not count toward the verdict',
      );
    });
  }
  const isBlocking = (f: Finding): boolean => f.severity === 'S0' || f.severity === 'S1';
  const blocking = review.findings.filter((f) => isBlocking(f) && !misplaced.has(f));
  if (review.verdict === 'pass' && blocking.length > 0) {
    // A contradictory review is not a usable output: the merge gate reads `verdict` alone
    // (规划/11 §3.2 评审无 S0 / S1), so "pass" must never carry blocking findings.
    errors.push(
      `verdict is "pass" but ${blocking.length} S0/S1 finding(s) are listed (a pass cannot carry blocking findings)`,
    );
  }
  if (
    review.verdict === 'fail' &&
    blocking.length === 0 &&
    review.findings.some((f) => isBlocking(f) && misplaced.has(f))
  ) {
    warnings.push(
      'verdict is "fail" only because of S0/S1 findings outside the task refs: within the refs this review is a pass',
    );
  }

  if (opts.money) {
    for (const item of CHECKLIST_ITEMS) {
      const entries = review.checklist.filter((c) => c.item === item);
      if (entries.length !== 1) {
        errors.push(`checklist: "${item}" must appear exactly once (found ${entries.length})`);
      }
    }
    review.checklist.forEach((c, i) => {
      const at = `checklist[${i}] (${c.item})`;
      if (c.file.trim() === '' || c.line < 1) {
        errors.push(`${at}: needs file and line >= 1 (规划/11 §3.3)`);
      } else if (opts.lineChecker !== undefined) {
        const result = opts.lineChecker(c.file, c.line);
        if (!result.ok) errors.push(`${at}: ${c.file}:${c.line} ${result.reason}`);
      }
      if (c.note.trim() === '') errors.push(`${at}: note is empty (state what was checked)`);
    });
    if (review.checklist.some((c) => c.status === 'issue') && review.findings.length === 0) {
      errors.push('checklist: an item has status "issue" but there is no finding');
    }
  }
  return { errors, warnings };
}

function isReviewSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const properties = (schema as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null && 'findings' in properties;
}

/** Full validation of one output document. */
export function validateOutput(
  schema: unknown,
  data: unknown,
  opts: { money: boolean; lineChecker?: LineChecker; refs?: readonly string[] },
): Report {
  const errors = schemaErrors(schema, data);
  const warnings: string[] = [];
  if (errors.length === 0 && isReviewSchema(schema)) {
    const problems = reviewProblems(data as ReviewOutput, opts);
    errors.push(...problems.errors);
    warnings.push(...problems.warnings);
  } else if (errors.length === 0 && opts.money) {
    throw new UsageError('--money applies to review outputs only');
  }
  return { ok: errors.length === 0, errors, warnings };
}

function parseArgs(argv: readonly string[]): {
  schema: string;
  file: string;
  money: boolean;
  json: boolean;
  refs: string[];
  diffBase?: string;
  cwd?: string;
} {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--money' || arg === '--json') {
      switches.add(arg);
    } else if (['--schema', '--file', '--diff-base', '--cwd', '--refs'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      values.set(arg, value);
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  const schema = values.get('--schema');
  const file = values.get('--file');
  if (schema === undefined || file === undefined) {
    throw new UsageError('--schema <file> and --file <json> are required');
  }
  const diffBase = values.get('--diff-base');
  const cwd = values.get('--cwd');
  if ((diffBase === undefined) !== (cwd === undefined)) {
    throw new UsageError('--diff-base and --cwd must be given together');
  }
  const refs = (values.get('--refs') ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  for (const ref of refs) {
    if (!/^[A-Za-z0-9-]+$/.test(ref)) throw new UsageError(`--refs: invalid rule id "${ref}"`);
  }
  const parsed = {
    schema,
    file,
    money: switches.has('--money'),
    json: switches.has('--json'),
    refs,
  };
  return diffBase !== undefined && cwd !== undefined ? { ...parsed, diffBase, cwd } : parsed;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (!existsSync(args.file)) throw new UsageError(`--file ${args.file}: no such file`);
  const schema = readJsonFile(args.schema);

  let report: Report;
  let data: unknown;
  let parseError = '';
  try {
    data = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  if (parseError !== '') {
    report = { ok: false, errors: [`output is not valid JSON: ${parseError}`], warnings: [] };
  } else {
    const lineChecker =
      args.money && args.diffBase !== undefined && args.cwd !== undefined
        ? gitLineChecker(args.diffBase, args.cwd)
        : undefined;
    const opts: { money: boolean; lineChecker?: LineChecker; refs?: string[] } = {
      money: args.money,
    };
    if (lineChecker !== undefined) opts.lineChecker = lineChecker;
    if (args.refs.length > 0) opts.refs = args.refs;
    report = validateOutput(schema, data, opts);
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const problem of report.errors) process.stderr.write(`invalid: ${problem}\n`);
  if (report.ok) process.stderr.write('validate-output: ok\n');
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`validate-output.ts: ${message}\n`);
    process.exitCode = 2;
  }
}

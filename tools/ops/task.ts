// Task ledger checks (规划/11 §2.1, planning docs/templates/task-ledger.md).
//
//   node tools/ops/task.ts check [id...]     validate ops/tasks/*.yaml
//   node tools/ops/task.ts show <id> --json  task fields plus the computed risk
//   node tools/ops/task.ts hash <id>         print the refs_hash block to paste
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { matchesAny } from '../lib/glob.ts';
import { repoRoot } from '../lib/paths.ts';
import { listTaskIds, parseTaskFile } from '../lib/task-file.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { assertTaskId, CheckError, runGuard, runMain, TASK_ID, UsageError } from './cli.ts';
import { literalPrefix } from './overlap.ts';
import { findRule, ruleHash, taskIdKnown } from './spec.ts';
import type { SpecSource } from './spec.ts';

export const MAX_TASK_LINES = 40;

export type RiskLevel = 'RV0' | 'RV1' | 'RV2';
export type RiskReport = {
  risk: RiskLevel;
  ask: boolean;
  paths: { path: string; risk: RiskLevel; rule: string | null; protected: null | 1 | 2 | 3 }[];
};

export type CheckOptions = {
  root?: string;
  spec?: SpecSource;
  /** Injected by tests; defaults to the guard in the trusted root. */
  risk?: (paths: readonly string[]) => RiskReport;
};

/** Risk level of a set of paths, computed by the trusted guard (规划/11 §1.2). */
export function riskOfPaths(paths: readonly string[]): RiskReport {
  const res = runGuard('risk-of-paths.ts', ['--json', '--stdin'], { input: paths.join('\n') });
  if (res.status !== 0) {
    throw new Error(`risk-of-paths.ts exited ${res.status}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as RiskReport;
  if (!['RV0', 'RV1', 'RV2'].includes(parsed.risk)) {
    throw new Error(`risk-of-paths.ts returned an unknown risk: ${String(parsed.risk)}`);
  }
  return parsed;
}

function tasksDir(root: string): string {
  return join(root, 'ops', 'tasks');
}

/** Ids of archived tasks (`ops/tasks/archive/<yyyymm>/<id>.yaml`), all of them done. */
export function archivedTaskIds(root: string = repoRoot()): string[] {
  const dir = join(tasksDir(root), 'archive');
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const month of readdirSync(dir, { withFileTypes: true })) {
    if (!month.isDirectory()) continue;
    for (const f of readdirSync(join(dir, month.name))) {
      if (f.endsWith('.yaml')) ids.push(f.slice(0, -'.yaml'.length));
    }
  }
  return ids.sort();
}

export function readTaskText(id: string, root: string = repoRoot()): string {
  const file = join(tasksDir(root), `${id}.yaml`);
  if (!existsSync(file)) throw new CheckError(`ops/tasks/${id}.yaml does not exist`);
  return readFileSync(file, 'utf8');
}

export function readTask(id: string, root: string = repoRoot()): TaskFile {
  return parseTaskFile(readTaskText(id, root), `${id}.yaml`);
}

/** The current `refs_hash` values for a task, from the planning text at SPEC_REF. */
export function computeRefsHash(
  refs: readonly string[],
  spec?: SpecSource,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) out[ref] = ruleHash(findRule(ref, spec));
  return out;
}

/** Class 1 of the protected paths (the rule-test assets) of `root`, fragments removed. */
export function ruleTestGlobs(root: string): string[] {
  const file = join(root, 'tools', 'guard', 'protected-paths.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { class1_add_only?: unknown };
  if (!Array.isArray(raw.class1_add_only)) throw new Error(`${file}: class1_add_only missing`);
  return raw.class1_add_only.map((g) => String(g).replace(/#.*$/, ''));
}

/** True when every path `glob` can match lies inside one of `globs` (by its literal prefix). */
export function insideGlobs(glob: string, globs: readonly string[]): boolean {
  const prefix = literalPrefix(glob);
  if (prefix === glob) return matchesAny(glob, globs);
  // Everything the glob matches lies below `dir`: inside when a `**` glob covers that directory.
  const dir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  return (
    dir !== '' && matchesAny(`${dir}__file__`, globs) && matchesAny(`${dir}__dir__/__file__`, globs)
  );
}

/** All problems of one task file; an empty list means the file is valid. */
export function checkTask(id: string, opts: CheckOptions = {}): string[] {
  const root = opts.root ?? repoRoot();
  const problems: string[] = [];
  const text = readTaskText(id, root);

  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  if (lines > MAX_TASK_LINES) {
    problems.push(`${lines} lines, the limit is ${MAX_TASK_LINES} (规划/11 §5.1)`);
  }

  let task: TaskFile;
  try {
    task = parseTaskFile(text, `${id}.yaml`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return problems;
  }

  if (task.id !== id) problems.push(`id "${task.id}" does not match the file name ${id}.yaml`);

  const prefix = task.id.replace(/[a-z]+$/, '');
  try {
    if (!taskIdKnown(prefix, opts.spec)) {
      problems.push(`task id prefix ${prefix} is not a task row of 规划/05 at SPEC_REF`);
    }
  } catch (err) {
    problems.push(`cannot read 规划/05 at SPEC_REF: ${err instanceof Error ? err.message : err}`);
  }

  for (const ref of task.refs) {
    let expected: string;
    try {
      expected = ruleHash(findRule(ref, opts.spec));
    } catch (err) {
      problems.push(`refs: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const recorded = task.refs_hash[ref];
    if (recorded === undefined) {
      problems.push(`refs_hash: missing entry for ${ref} (expected ${expected})`);
    } else if (recorded !== expected) {
      problems.push(
        `refs_hash: ${ref} is ${recorded} but the text at SPEC_REF hashes to ${expected} (task is stale)`,
      );
    }
  }
  for (const key of Object.keys(task.refs_hash)) {
    if (!task.refs.includes(key)) problems.push(`refs_hash: ${key} is not listed in refs`);
  }

  const known = new Set([...listTaskIds(root), ...archivedTaskIds(root)]);
  for (const dep of task.deps) {
    if (dep === task.id) problems.push(`deps: a task cannot depend on itself`);
    else if (!known.has(dep)) problems.push(`deps: ${dep} is not in ops/tasks`);
  }

  // test_paths (2026-10-05): only the rule-test author's assets, i.e. inside class 1 of the
  // protected paths, and only for a task that has a rule-test author.
  if (task.test_paths.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'test_paths: a task without a rule-test author (tester: none) has no test_paths',
      );
    }
    let class1: string[] = [];
    try {
      class1 = ruleTestGlobs(root);
    } catch (err) {
      problems.push(`test_paths: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const glob of task.test_paths) {
      if (class1.length > 0 && !insideGlobs(glob, class1)) {
        problems.push(
          `test_paths: "${glob}" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)`,
        );
      }
    }
  }

  if (task.paths.length === 0) {
    problems.push('paths: must not be empty');
  } else if (task.type === 'impl' || task.type === 'migration') {
    // Hard rule 3 (规划/11 §0) and §2.3 step 3: RV2 work needs rule tests written
    // by the other model.
    try {
      const report = (opts.risk ?? riskOfPaths)(task.paths);
      if (report.risk === 'RV2') {
        if (task.tester === 'none') {
          problems.push('tester: RV2 tasks need a rule-test author (规划/11 §2.3 step 3)');
        } else if (task.tester === task.impl) {
          problems.push(
            `tester: must differ from impl (${task.impl}) for RV2 tasks (规划/11 §0 rule 3)`,
          );
        }
      }
    } catch (err) {
      problems.push(`risk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return problems;
}

export type CheckResult = { id: string; problems: string[] };

export function checkTasks(ids: readonly string[] = [], opts: CheckOptions = {}): CheckResult[] {
  const root = opts.root ?? repoRoot();
  const wanted = ids.length > 0 ? [...ids] : listTaskIds(root);
  const results: CheckResult[] = [];
  for (const id of wanted) {
    try {
      results.push({ id, problems: checkTask(id, opts) });
    } catch (err) {
      results.push({ id, problems: [err instanceof Error ? err.message : String(err)] });
    }
  }
  // Files that are not `<id>.yaml` would silently stay out of the ledger.
  if (ids.length === 0) {
    const dir = tasksDir(root);
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== 'archive') {
            results.push({ id: entry.name, problems: ['unexpected directory in ops/tasks'] });
          }
        } else if (!entry.name.endsWith('.yaml') || !TASK_ID.test(entry.name.slice(0, -5))) {
          results.push({ id: entry.name, problems: ['file name is not <task id>.yaml'] });
        }
      }
    }
  }
  return results;
}

export type TaskView = TaskFile & {
  risk: RiskLevel;
  ask: boolean;
  risk_paths: RiskReport['paths'];
};

export function showTask(id: string, opts: CheckOptions = {}): TaskView {
  const task = readTask(id, opts.root ?? repoRoot());
  const report = (opts.risk ?? riskOfPaths)(task.paths);
  return { ...task, risk: report.risk, ask: report.ask, risk_paths: report.paths };
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (cmd === 'check') {
    const results = checkTasks(rest.map((id) => assertTaskId(id)));
    const failed = results.filter((r) => r.problems.length > 0);
    if (values.json) {
      console.log(JSON.stringify({ ok: failed.length === 0, tasks: results }, null, 2));
    }
    for (const r of failed) {
      for (const p of r.problems) console.error(`ops/tasks/${r.id}: ${p}`);
    }
    console.error(
      failed.length === 0
        ? `台账检查通过：${results.length} 个任务`
        : `台账检查失败：${failed.length} / ${results.length} 个任务有问题`,
    );
    return failed.length === 0 ? 0 : 1;
  }
  if (cmd === 'show') {
    if (!values.json) throw new UsageError('show needs --json');
    console.log(JSON.stringify(showTask(assertTaskId(rest[0])), null, 2));
    return 0;
  }
  if (cmd === 'hash') {
    const task = readTask(assertTaskId(rest[0]));
    const hashes = computeRefsHash(task.refs);
    if (values.json) {
      console.log(JSON.stringify(hashes, null, 2));
    } else {
      console.log('refs_hash:');
      for (const [ref, hash] of Object.entries(hashes)) {
        // An all-digit hash would be read back as a number: quote it.
        const scalar = /^[0-9]+(e[0-9]+)?$/.test(hash) ? `'${hash}'` : hash;
        console.log(`  ${ref}: ${scalar}`);
      }
    }
    return 0;
  }
  throw new UsageError('expected: check [id...] | show <id> --json | hash <id>');
}

if (import.meta.main) runMain(main);

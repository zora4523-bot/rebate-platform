// Task ledger checks (规划/11 §2.1, planning docs/templates/task-ledger.md).
//
//   node tools/ops/task.ts check [id...]     validate ops/tasks/*.yaml
//   node tools/ops/task.ts show <id> --json  task fields plus the computed risk
//   node tools/ops/task.ts hash <id>         print the refs_hash block to paste
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { matchesAny } from '../lib/glob.ts';
import {
  isCodexFirst,
  loadCodexImplForbidden,
  loadCodexImplTasks,
} from '../lib/codex-impl-tasks.ts';
import { loadLegacyTasks, needsTestPaths } from '../lib/legacy-tasks.ts';
import { repoRoot } from '../lib/paths.ts';
import { listTaskIds, parseTaskFile } from '../lib/task-file.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { assertTaskId, CheckError, runGuard, runMain, TASK_ID, UsageError } from './cli.ts';
import { globsMayOverlap, literalPrefix } from './overlap.ts';
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
  /** Injected by tests: many sets at once; defaults to `risk` per set, or the trusted guard. */
  riskSets?: (sets: readonly (readonly string[])[]) => RiskReport[];
  /** Told when the combined guard call is unusable (the check then asks per task). */
  onRiskFallback?: (reason: string) => void;
};

/** The guard calls checkTasks and the status board batch (batchRisk). */
export function riskSources(opts: {
  risk?: (paths: readonly string[]) => RiskReport;
  riskSets?: (sets: readonly (readonly string[])[]) => RiskReport[];
  onRiskFallback?: (reason: string) => void;
}): RiskSources {
  const one = opts.risk;
  const many =
    opts.riskSets ?? (one ? (sets: readonly (readonly string[])[]) => sets.map(one) : undefined);
  return { many, one, onFallback: opts.onRiskFallback };
}

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

/** Risk reports of many path sets from one call of the trusted guard (`risk-of-paths.ts --sets`). */
export function riskOfPathSets(sets: readonly (readonly string[])[]): RiskReport[] {
  const res = runGuard('risk-of-paths.ts', ['--sets'], { input: JSON.stringify(sets) });
  if (res.status !== 0) {
    throw new Error(`risk-of-paths.ts --sets exited ${res.status}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== sets.length) {
    throw new Error(`risk-of-paths.ts --sets did not answer one report per set`);
  }
  for (const report of parsed as RiskReport[]) {
    if (!['RV0', 'RV1', 'RV2'].includes(report?.risk)) {
      throw new Error(`risk-of-paths.ts --sets returned an unknown risk: ${String(report?.risk)}`);
    }
  }
  return parsed as RiskReport[];
}

export type RiskSources = {
  /** One report per set, in order (default: the trusted guard, riskOfPathSets). */
  many?: ((sets: readonly (readonly string[])[]) => RiskReport[]) | undefined;
  /** One set (default: the trusted guard, riskOfPaths). */
  one?: ((paths: readonly string[]) => RiskReport) | undefined;
  /** Told once when the combined call is unusable and every set is asked on its own. */
  onFallback?: ((reason: string) => void) | undefined;
};

/**
 * Risk of many path sets from one call of the trusted guard. risk-of-paths.ts runs as a process of
 * its own, and one call per task (one Node start-up each) made the whole-ledger check outgrow its
 * test timeout once the ledger passed a hundred tasks. The guard computes every report itself
 * (`--sets`), so its aggregation is not repeated here. A set asked about that was not in `sets`, or
 * every set when the combined call fails, is asked on its own as before.
 */
export function batchRisk(
  sets: readonly (readonly string[])[],
  sources: RiskSources = {},
): (paths: readonly string[]) => RiskReport {
  const many = sources.many ?? riskOfPathSets;
  const one = sources.one ?? riskOfPaths;
  const key = (paths: readonly string[]): string => JSON.stringify(paths);
  // undefined: not asked yet; null: the combined call is unusable.
  let answers: Map<string, RiskReport> | null | undefined;
  return (paths) => {
    if (answers === undefined) {
      answers = null;
      const unique = [...new Map(sets.map((set) => [key(set), set])).values()];
      try {
        const reports = unique.length > 0 ? many(unique) : [];
        if (reports.length !== unique.length) throw new Error('not one report per set');
        answers = new Map(unique.map((set, i) => [key(set), reports[i]!]));
      } catch (err) {
        sources.onFallback?.(err instanceof Error ? err.message : String(err));
      }
    }
    return answers?.get(key(paths)) ?? one(paths);
  };
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
  // protected paths, and only for a task that has a rule-test author. A task with a rule-test
  // author needs them, unless its ledger existed at the switch baseline (CR2-02).
  // CR3-03: a ledger written after the switch follows the default split: the Opus subagent
  // implements (impl: claude; a handover is recorded at run time, never in the ledger) and the
  // rule tests are Codex's or there are none.
  // Owner 2026-10-06 (ops/approvals.yaml id 23): a task of tools/guard/codex-impl-tasks.json may
  // instead name impl: codex with tester: claude (Claude writes the rule tests first, Codex
  // implements); every other new ledger keeps the default split.
  const legacy = loadLegacyTasks(root);
  const codexFirst = isCodexFirst(task, loadCodexImplTasks(root));
  if (codexFirst) {
    // Claude review S2-1: the list is per split task, but a suffix says nothing about content; a
    // Codex-first ledger may only be implementation work outside funds, attribution, payout,
    // migrations, contracts, clients and gates (tools/guard/codex-impl-tasks.json forbidden_paths).
    if (task.type !== 'impl') {
      problems.push(
        `type: a Codex implementation (tools/guard/codex-impl-tasks.json) is for type impl only, not ${task.type}`,
      );
    }
    const forbidden = loadCodexImplForbidden(root);
    if (forbidden.length === 0) {
      problems.push(
        'paths: tools/guard/codex-impl-tasks.json has no forbidden_paths; a Codex implementation is refused (fail-closed)',
      );
    }
    for (const glob of task.paths) {
      const hit = forbidden.find((f) => globsMayOverlap(glob, f));
      if (hit !== undefined) {
        problems.push(
          `paths: "${glob}" reaches "${hit}", which stays with the default split (ops/approvals.yaml id 19), not a Codex implementation`,
        );
      }
    }
  }
  if (!legacy.has(task.id) && !codexFirst) {
    if (task.impl !== 'claude') {
      problems.push(
        `impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)`,
      );
    }
    if (task.tester !== 'codex' && task.tester !== 'none') {
      problems.push(
        `tester: must be codex or none for a task written after the switch of 2026-10-05`,
      );
    }
  }
  if (task.test_paths.length === 0 && needsTestPaths(task, legacy)) {
    problems.push(
      `test_paths: required for a task with a rule-test author (tester: ${task.tester}); only the ledgers listed in tools/guard/legacy-tasks.json may omit it`,
    );
  }
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
  // One guard call for the whole ledger instead of one per task (batchRisk): the path sets of
  // the tasks whose risk checkTask asks for.
  const risk = batchRisk(
    wanted.flatMap((id) => {
      try {
        const task = readTask(id, root);
        return task.type === 'impl' || task.type === 'migration' ? [task.paths] : [];
      } catch {
        return [];
      }
    }),
    riskSources(opts),
  );
  const results: CheckResult[] = [];
  for (const id of wanted) {
    try {
      results.push({ id, problems: checkTask(id, { ...opts, risk }) });
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
    const results = checkTasks(
      rest.map((id) => assertTaskId(id)),
      {
        onRiskFallback: (reason) =>
          console.error(`notice: risk asked per task (${reason.split('\n')[0]})`),
      },
    );
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

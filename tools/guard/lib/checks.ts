// The guard checks as functions returning a CheckResult. The CLIs in tools/guard/*.ts and
// run.ts are thin wrappers around these.
//
// Two roots are involved (规划/11 §2.4):
// - `root`: the tree under inspection (a task worktree, the main checkout, the verify copy);
// - trustedRoot(): where gate data is read from (task `paths`, protected-path list, risk map
//   for risk levels, banned-term list), so a branch cannot weaken its own gate.
// Checks that verify the consistency of the inspected tree itself (risk-map coverage, the
// AGENTS.md table, the embedded workflow copy) read both sides from `root`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../../lib/fsx.ts';
import { changedBetweenCommits, changedFiles, listTree, showFile, tryGit } from '../../lib/git.ts';
import { loadLegacyTasks } from '../../lib/legacy-tasks.ts';
import { specRepo, trustedRoot } from '../../lib/paths.ts';
import { loadTask, parseTaskFile, TASK_ID_PATTERN } from '../../lib/task-file.ts';
import { checkAgentsPairs } from './agents-pair.ts';
import { extractTable, renderRiskTable } from './agents-table.ts';
import { parseAllow, parseTerms, scanText } from './banned-terms.ts';
import type { AllowEntry, Term } from './banned-terms.ts';
import { result, skipped } from './cli.ts';
import type { CheckResult } from './cli.ts';
import { scanFilesForHiddenUnicode } from './hidden-unicode.ts';
import { checkLockfile } from './lockfile.ts';
import { checkPaths } from './path-guard.ts';
import type { PathGuardResult } from './path-guard.ts';
import { compareEmbedded, compareEmbeddedScript } from './protected-sync.ts';
import { findProtectedHits, gitReaders, loadProtected, splitFragment } from './protected.ts';
import type { ProtectedHit } from './protected.ts';
import { checkCoverage } from './risk-map-coverage.ts';
import { loadRiskMap } from './risk.ts';
import { lintSchema } from './schema-lint.ts';
import { authorProblems, checkAuthorPaths } from './spec-base.ts';
import { checkSpecRef } from './spec-ref.ts';
import { addOnlyViolations, scanTree } from './test-guard.ts';
import type { Finding } from './test-guard.ts';
import type { TreeListing } from './tree.ts';

export const SCHEMA_DIR = 'tools/agent/schemas';
export const PROTECTED_WORKFLOW = '.github/workflows/protected-paths.yml';
export const OWNER_APPROVAL_SCRIPT = 'tools/guard/lib/owner-approval.mjs';

/** schema-lint: explicit files (absolute or relative to the current directory), or the schema dir. */
export function schemaLintCheck(root: string, explicit: readonly string[] = []): CheckResult {
  const name = 'schema-lint';
  let files: { label: string; path: string }[];
  if (explicit.length > 0) {
    files = explicit.map((f) => ({ label: f, path: f }));
  } else {
    const dir = join(root, SCHEMA_DIR);
    if (!existsSync(dir)) return skipped(name, `${SCHEMA_DIR} does not exist yet`);
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ label: `${SCHEMA_DIR}/${f}`, path: join(dir, f) }));
    if (files.length === 0) return skipped(name, `${SCHEMA_DIR} contains no schema yet`);
  }
  const problems: string[] = [];
  for (const file of files) {
    try {
      problems.push(...lintSchema(readJsonFile(file.path), file.label));
    } catch (err) {
      problems.push(`${file.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result(name, problems);
}

export function agentsPairCheck(root: string, tree: TreeListing): CheckResult {
  return result('agents-pair', checkAgentsPairs(root, tree.files));
}

export function riskMapCoverageCheck(root: string): CheckResult {
  const { problems, notices } = checkCoverage(root, loadRiskMap(root));
  return result('risk-map-coverage', problems, notices);
}

export function agentsTableCheck(root: string): CheckResult {
  const name = 'agents-table';
  const file = join(root, 'AGENTS.md');
  if (!existsSync(file)) return result(name, ['AGENTS.md is missing']);
  const expected = renderRiskTable(loadRiskMap(root));
  let actual: string;
  try {
    actual = extractTable(readFileSync(file, 'utf8'));
  } catch (err) {
    return result(name, [err instanceof Error ? err.message : String(err)]);
  }
  return result(
    name,
    actual === expected
      ? []
      : [
          'the 分工 table in AGENTS.md differs from ops/risk-map.yaml (run: node tools/guard/agents-table.ts --write)',
        ],
  );
}

export function protectedSyncCheck(root: string): CheckResult {
  const name = 'protected-sync';
  const workflow = join(root, PROTECTED_WORKFLOW);
  if (!existsSync(workflow)) return skipped(name, `${PROTECTED_WORKFLOW} does not exist yet`);
  const source = readJsonFile(join(root, 'tools', 'guard', 'protected-paths.json'));
  const text = readFileSync(workflow, 'utf8');
  const scriptFile = join(root, OWNER_APPROVAL_SCRIPT);
  const scriptProblems = existsSync(scriptFile)
    ? compareEmbeddedScript(readFileSync(scriptFile, 'utf8'), text)
    : [`${OWNER_APPROVAL_SCRIPT} is missing, so its embedded copy cannot be compared`];
  return result(
    name,
    [...compareEmbedded(source, text), ...scriptProblems].map((p) => `${PROTECTED_WORKFLOW}: ${p}`),
  );
}

function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: [${f.rule}] ${f.message}`;
}

export function testGuardStatic(root: string, tree: TreeListing): Finding[] {
  return scanTree(root, tree.files);
}

export function testGuardCheck(
  root: string,
  tree: TreeListing,
  base?: string,
): CheckResult & { findings: Finding[]; add_only_violations: ProtectedHit[] } {
  const findings = testGuardStatic(root, tree);
  const addOnly =
    base === undefined
      ? []
      : addOnlyViolations(changedFiles(base, { cwd: root }), loadProtected(trustedRoot()));
  const problems = [...findings.map(formatFinding), ...addOnly.map(addOnlyProblem)];
  return { ...result('test-guard', problems), findings, add_only_violations: addOnly };
}

/** The test-guard problem line for a changed class 1 (add-only) test asset. */
export function addOnlyProblem(hit: ProtectedHit): string {
  return `${hit.path}: [add-only] existing test asset ${hit.change} (matches ${hit.rule})`;
}

/**
 * Turns the problems selected by `waived` into warnings (printed, not failing); the check fails
 * only when other problems remain. guard-git uses it for an owner-approved head (规划/11 §4.4):
 * every protected-paths problem and the add-only problems of test-guard; nothing else.
 */
export function waiveProblems(
  check: CheckResult,
  waived: (problem: string) => boolean,
  note: string,
): CheckResult {
  const warnings = check.problems.filter(waived);
  if (warnings.length === 0) return check;
  const problems = check.problems.filter((p) => !waived(p));
  return {
    ...check,
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
    notices: [...check.notices, note],
    warnings: [...(check.warnings ?? []), ...warnings],
  };
}

export function hiddenUnicodeCheck(root: string, tree: TreeListing): CheckResult {
  const { problems, notices } = scanFilesForHiddenUnicode(root, tree.files);
  return result('hidden-unicode', problems, notices);
}

/** Every URL in pnpm-lock.yaml is a clean https://registry.npmjs.org/ URL (规划/11 §8). */
export function lockfileCheck(root: string): CheckResult {
  const { problems, notices } = checkLockfile(root);
  return result('lockfile-urls', problems, notices);
}

/**
 * The planning repository is required wherever the inspected tree is a git checkout (host,
 * CI). The verify container has neither `.git` nor the planning repository: there the checks
 * that need it are skipped with a notice.
 */
export function specRepoRequired(root: string, allowMissing: boolean): boolean {
  return !allowMissing && existsSync(join(root, '.git'));
}

export function specRefCheck(root: string, opts: { requireSpecRepo: boolean }): CheckResult {
  return checkSpecRef(root, specRepo(), opts);
}

function loadTermConfig(): { terms: Term[]; allow: AllowEntry[] } {
  const dir = join(trustedRoot(), 'tools', 'guard');
  const allowFile = join(dir, 'banned-terms.allow.txt');
  return {
    terms: parseTerms(readFileSync(join(dir, 'banned-terms.txt'), 'utf8')),
    allow: existsSync(allowFile) ? parseAllow(readFileSync(allowFile, 'utf8')) : [],
  };
}

/** Scans `规划/**` of the planning repository at the SPEC_REF of `root`, through git only. */
export function bannedTermsSpecCheck(
  root: string,
  opts: { requireSpecRepo: boolean },
): CheckResult {
  const name = 'banned-terms';
  const repo = specRepo();
  if (!existsSync(repo)) {
    const notice = `planning repository not found at ${repo}; 规划/ not scanned`;
    return opts.requireSpecRepo ? result(name, [notice]) : skipped(name, notice);
  }
  const refFile = join(root, 'SPEC_REF');
  if (!existsSync(refFile)) return result(name, ['SPEC_REF is missing']);
  const ref = readFileSync(refFile, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(ref)) return result(name, ['SPEC_REF is not a commit id']);
  const { terms, allow } = loadTermConfig();
  const files = listTree(repo, ref, '规划');
  if (files.length === 0) return result(name, [`no files under 规划/ at ${ref}`]);
  const problems: string[] = [];
  for (const file of files) {
    const content = showFile(repo, ref, file);
    if (content.includes('\0')) continue;
    for (const hit of scanText(file, content, terms, allow)) {
      problems.push(`${hit.file}:${hit.line}: banned term "${hit.term}": ${hit.excerpt}`);
    }
  }
  return result(name, problems, [
    `scanned ${files.length} files under 规划/ at ${ref.slice(0, 12)}`,
  ]);
}

/** Scans the given files (task briefs); allow entries apply by the path as given. */
export function bannedTermsFilesCheck(files: readonly string[]): CheckResult {
  const { terms, allow } = loadTermConfig();
  const problems: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      problems.push(`${file}: cannot be read`);
      continue;
    }
    for (const hit of scanText(file, content, terms, allow)) {
      problems.push(`${hit.file}:${hit.line}: banned term "${hit.term}": ${hit.excerpt}`);
    }
  }
  return result('banned-terms', problems);
}

export type PathGuardOutcome = { check: CheckResult; detail: PathGuardResult };

/** Path guard for a diff of `root` against `base`; `allowed` are the task's path globs. */
export function pathGuardCheck(
  root: string,
  base: string,
  allowed: readonly string[],
  taskType: string | undefined,
): PathGuardOutcome {
  const changes = changedFiles(base, { cwd: root });
  const hits = findProtectedHits(changes, loadProtected(trustedRoot()), gitReaders(root, base), {
    taskType,
  });
  const detail = checkPaths(changes, allowed, hits);
  const notices = [
    ...detail.out_of_scope_ops_docs.map(
      // TODO(规划/11 §2.3): revert out-of-scope ops/ and docs/ changes automatically and record
      // them — blocked on the orchestrator scripts in tools/ops (report only for now).
      (p) => `${p}: out-of-scope change under ops/ or docs/ (to be reverted by the orchestrator)`,
    ),
    ...detail.protected_hits.map((h) => `${h.path}: protected path, class ${h.class}`),
  ];
  return {
    check: result(
      'path-guard',
      detail.violations.map((v) => `${v.path}: ${v.reason}`),
      notices,
    ),
    detail,
  };
}

/**
 * The rule-test author's part of a task branch, base..spec_commit (规划/11 §2.3 step 3; owner
 * decision 2026-10-02): only rule-test assets (class 1 of the trusted protected-path list), the
 * ops/tasks ledger and NotImplemented skeleton shells inside the task paths (lib/spec-base.ts).
 */
export function authorPathsCheck(
  root: string,
  base: string,
  specCommit: string,
  task: { id: string; tester: string; paths: readonly string[]; test_paths: readonly string[] },
): CheckResult {
  // The task's test_paths. Only a ledger of the switch baseline (tools/guard/legacy-tasks.json,
  // read from the trusted root) may have none and keep the old scope (all rule-test assets);
  // any other task without test_paths gets no rule-test asset at all (CR2-02, fail-closed).
  const legacy = loadLegacyTasks(trustedRoot()).has(task.id);
  const testPaths = task.test_paths;
  const taskPaths = task.paths;
  const testAssets =
    testPaths.length > 0
      ? [...testPaths]
      : legacy
        ? loadProtected(trustedRoot()).class1_add_only.map((g) => splitFragment(g).glob)
        : [];
  const changes = changedBetweenCommits(base, specCommit, { cwd: root });
  const show = (ref: string, path: string): string | null => {
    const res = tryGit(['show', `${ref}:${path}`], { cwd: root });
    return res.status === 0 ? res.stdout : null;
  };
  const problems = authorProblems(changes, {
    taskPaths,
    testAssets,
    contentAtSpec: (path) => show(specCommit, path),
    contentAtBase: (path) => show(base, path),
  });
  if (testPaths.length === 0 && !legacy && task.tester !== 'none') {
    problems.unshift(
      `task ${task.id} has no test_paths and is not a ledger of the switch baseline ` +
        '(tools/guard/legacy-tasks.json): add test_paths to its ledger',
    );
  }
  return result('path-guard-author', problems, [
    `${changes.length} path(s) changed by the rule-test commits ${base.slice(0, 12)}..${specCommit.slice(0, 12)}`,
  ]);
}

/**
 * Path guard of a rule-test run (`path-guard.ts --author`): the working tree of `root` against
 * `base` may only hold rule-test assets and NotImplemented skeleton shells inside the task
 * paths (lib/spec-base.ts checkAuthorPaths; default split of 2026-10-05, ops/approvals.yaml
 * id 19). Out-of-scope ops/ and docs/ changes are reported apart, as in pathGuardCheck.
 */
export function authorWorktreeCheck(
  root: string,
  base: string,
  taskPaths: readonly string[],
  taskType: string | undefined,
  testPaths: readonly string[],
): PathGuardOutcome {
  const protectedList = loadProtected(trustedRoot());
  const changes = changedFiles(base, { cwd: root });
  const hits = findProtectedHits(changes, protectedList, gitReaders(root, base), { taskType });
  // Only the task's own test_paths (CR-06): no test_paths, no rule-test asset is allowed.
  const detail = checkAuthorPaths(
    changes,
    {
      taskPaths,
      testAssets: testPaths,
      contentAtSpec: (path) => {
        const file = join(root, path);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      },
      contentAtBase: (path) => {
        const res = tryGit(['show', `${base}:${path}`], { cwd: root });
        return res.status === 0 ? res.stdout : null;
      },
    },
    hits,
  );
  if (testPaths.length === 0) {
    detail.ok = false;
    detail.violations.unshift({
      path: 'ops/tasks',
      reason: 'the task has no test_paths: add them to the ledger before the test phase (CR-06)',
    });
  }
  return {
    check: result(
      'path-guard-author',
      detail.violations.map((v) => `${v.path}: ${v.reason}`),
      [
        ...detail.out_of_scope_ops_docs.map(
          (p) =>
            `${p}: out-of-scope change under ops/ or docs/ (to be reverted by the orchestrator)`,
        ),
        ...detail.protected_hits.map((h) => `${h.path}: protected path, class ${h.class}`),
      ],
    ),
    detail,
  };
}

export type ProtectedOutcome = { check: CheckResult; hits: ProtectedHit[] };

export function protectedPathsCheck(
  root: string,
  base: string,
  taskType: string | undefined,
): ProtectedOutcome {
  const hits = findProtectedHits(
    changedFiles(base, { cwd: root }),
    loadProtected(trustedRoot()),
    gitReaders(root, base),
    { taskType },
  );
  return {
    check: result(
      'protected-paths',
      hits.map((h) => `${h.path}: class ${h.class} (${h.rule}) ${h.change}`),
    ),
    hits,
  };
}

/** Task definition from the trusted root: a branch cannot widen its own `paths`. */
export function trustedTask(id: string): {
  paths: string[];
  type: string;
  test_paths: string[];
  tester: string;
} {
  const task = loadTask(id, trustedRoot());
  return { paths: task.paths, type: task.type, test_paths: task.test_paths, tester: task.tester };
}

export type GuardTask = {
  paths: string[];
  test_paths: string[];
  tester: string;
  type: string;
  source: 'trusted' | 'head';
  notice: string | null;
};

/**
 * Task definition for `run.ts git --task <id>` (owner decision 2026-10-02, ops/approvals.yaml
 * id 17): from the trusted root as before; only when the trusted root has no
 * `ops/tasks/<id>.yaml` AND the pull request itself adds that file (absent at `base`, present
 * in the committed `HEAD` of `root`) is the ledger read from the head. The id comes from the
 * task branch name, so a branch can only bring the ledger of its own task, never change one
 * that is already on the base; every other guard still reads the trusted root.
 */
export function guardTask(id: string, root: string, base: string): GuardTask {
  if (!TASK_ID_PATTERN.test(id)) throw new Error(`invalid task id: "${id}"`);
  if (base === '' || base.startsWith('-')) throw new Error(`invalid base: "${base}"`);
  const rel = `ops/tasks/${id}.yaml`;
  const trustedFile = join(trustedRoot(), rel);
  if (existsSync(trustedFile)) return { ...trustedTask(id), source: 'trusted', notice: null };
  const atBase = tryGit(['cat-file', '-e', `${base}:${rel}`], { cwd: root });
  if (atBase.status === 0) {
    throw new Error(
      `task file not found: ${trustedFile} (the base has ${rel}; the trusted copy is stale)`,
    );
  }
  const atHead = tryGit(['show', `HEAD:${rel}`], { cwd: root });
  if (atHead.status !== 0) {
    throw new Error(`task file not found: ${trustedFile}, and HEAD does not add ${rel}`);
  }
  const task = parseTaskFile(atHead.stdout, rel);
  return {
    paths: task.paths,
    test_paths: task.test_paths,
    tester: task.tester,
    type: task.type,
    source: 'head',
    notice:
      `task ${id}: no ${rel} on the base; the ledger is the one this pull request adds ` +
      '(read from HEAD, ops/approvals.yaml id 17)',
  };
}

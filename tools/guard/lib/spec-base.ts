// The rule-test commit (`spec_commit`) as the start of the implementer's path scope on a task
// branch (规划/11 §2.3 steps 3 and 6; owner decision 2026-10-02, ops/approvals.yaml id 14).
//
// A task branch carries two authors (规划/11 §2.3): first the rule-test author commits the rule
// tests, the NotImplemented skeleton and the ledger change (step 3) and records `spec_commit`;
// then the implementer works on top of it. guard-git splits the branch at the `spec_commit` of
// the task's evidence file (ops/evidence/<id>.json at the head) — only after checking that it lies
// on the branch: an ancestor of the head and a descendant of the base. Then
//   - spec_commit..head (working tree included) is the implementer's: the task `paths`, as before;
//   - base..spec_commit is the rule-test author's: rule-test assets (class 1 of
//     tools/guard/protected-paths.json), the ledger `ops/tasks/**`, and NotImplemented skeleton
//     shells inside the task `paths`; anything else fails.
// No evidence file, or a spec_commit that is not on base..head: the caller falls back to one
// range from the base (the behaviour before this split; it fails closed on rule tests).
import { tryGit } from '../../lib/git.ts';
import type { Change } from '../../lib/git.ts';
import { matchesAny } from '../../lib/glob.ts';
import type { PathGuardResult } from './path-guard.ts';
import type { ProtectedHit } from './protected.ts';
import { skeletonProblems } from './skeleton.ts';

/** A commit id as written in an evidence file (abbreviated ids accepted, as evidence-check does). */
export const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** The ledger directory the rule-test author may change (规划/11 §2.1 台账). */
export const LEDGER_PATHS: readonly string[] = ['ops/tasks/**'];

export function evidencePath(taskId: string): string {
  return `ops/evidence/${taskId}.json`;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant` in the repository at `dir`. */
export function isAncestor(dir: string, ancestor: string, descendant: string): boolean {
  return tryGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: dir }).status === 0;
}

function resolveCommit(dir: string, ref: string): string | null {
  if (ref === '' || ref.startsWith('-')) return null;
  const res = tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir });
  const sha = res.stdout.trim();
  return res.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export type SpecBase =
  { ok: true; specCommit: string; evidenceFile: string } | { ok: false; reason: string };

/**
 * The verified `spec_commit` of the task's evidence file at `head`: it must name a commit that
 * is an ancestor of `head` and a descendant of `base`, and the file's `task` must be `taskId`.
 * Never throws for bad data; the reason says why the split cannot be used.
 */
export function resolveSpecBase(dir: string, base: string, head: string, taskId: string): SpecBase {
  const file = evidencePath(taskId);
  const baseSha = resolveCommit(dir, base);
  const headSha = resolveCommit(dir, head);
  if (baseSha === null) return { ok: false, reason: `base ${base} is not a commit` };
  if (headSha === null) return { ok: false, reason: `head ${head} is not a commit` };
  const shown = tryGit(['show', `${headSha}:${file}`], { cwd: dir });
  if (shown.status !== 0) return { ok: false, reason: `no ${file} at the head` };
  let doc: unknown;
  try {
    doc = JSON.parse(shown.stdout);
  } catch {
    return { ok: false, reason: `${file} is not valid JSON` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: `${file} is not a JSON object` };
  }
  const record = doc as Record<string, unknown>;
  if (record['task'] !== taskId) {
    return {
      ok: false,
      reason: `${file}: task is ${JSON.stringify(record['task'])}, not "${taskId}"`,
    };
  }
  const specCommit = record['spec_commit'];
  if (typeof specCommit !== 'string' || !COMMIT_ID.test(specCommit)) {
    return { ok: false, reason: `${file}: spec_commit is not a commit id` };
  }
  const specSha = resolveCommit(dir, specCommit);
  if (specSha === null) {
    return {
      ok: false,
      reason: `${file}: spec_commit ${specCommit} is not a commit of this repository`,
    };
  }
  if (!isAncestor(dir, specSha, headSha)) {
    return {
      ok: false,
      reason: `${file}: spec_commit ${specCommit} is not an ancestor of the head`,
    };
  }
  if (!isAncestor(dir, baseSha, specSha)) {
    return {
      ok: false,
      reason: `${file}: spec_commit ${specCommit} is not a descendant of the base ${base}`,
    };
  }
  return { ok: true, specCommit: specSha, evidenceFile: file };
}

export type AuthorScope = {
  /** The task `paths` (from the trusted root): where skeleton shells go. */
  taskPaths: readonly string[];
  /**
   * Rule-test asset globs: the task's `test_paths`, or class 1 of the trusted protected-path
   * list for a ledger written before 2026-10-05 (commit check only; the run check requires
   * test_paths).
   */
  testAssets: readonly string[];
  /** Content of a file at spec_commit (or in the working tree), or null when it does not exist. */
  contentAtSpec: (path: string) => string | null;
  /** Content of a file at the base, or null when it does not exist there. */
  contentAtBase?: (path: string) => string | null;
  /**
   * A ledger on tools/guard/legacy-tasks.json: its skeletons follow the rule of before the
   * switch, the NotImplemented keyword in the file (CR3-02); every other task gets the
   * statement-by-statement check (lib/skeleton.ts).
   */
  legacySkeleton?: boolean;
};

/** The old skeleton rule (before 2026-10-05): the file names NotImplemented. */
const LEGACY_SKELETON_MARKER = /\bNotImplemented\b/;

/** Why a file the rule-test author changed inside the task paths is not a skeleton ([] = it is). */
function shellProblems(path: string, scope: AuthorScope): string[] {
  const content = scope.contentAtSpec(path);
  if (content === null) return ['missing'];
  if (scope.legacySkeleton === true) {
    return LEGACY_SKELETON_MARKER.test(content) ? [] : ['does not name NotImplemented'];
  }
  return skeletonProblems(path, content, scope.contentAtBase?.(path) ?? null);
}

/**
 * Problems of the rule-test author's changes (base..spec_commit). Allowed: rule-test assets, the
 * ledger, and files inside the task paths that are NotImplemented skeleton shells at spec_commit.
 * Implementation (a task-path file without the marker, or a deleted one) and every other path
 * fail.
 */
export function authorProblems(changes: readonly Change[], scope: AuthorScope): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const sides: [string, boolean][] = [[change.path, change.status === 'D']];
    if (change.oldPath !== undefined) sides.push([change.oldPath, true]);
    for (const [path, removed] of sides) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (matchesAny(path, scope.testAssets) || matchesAny(path, LEDGER_PATHS)) continue;
      if (matchesAny(path, scope.taskPaths)) {
        if (removed) {
          problems.push(
            `${path}: removed in a rule-test commit (before spec_commit); the rule-test author ` +
              'only adds NotImplemented skeleton shells inside the task paths',
          );
          continue;
        }
        const shell = shellProblems(path, scope);
        if (shell.length > 0) {
          problems.push(
            `${path}: implementation path changed in a rule-test commit (before spec_commit) but ` +
              `it is not a NotImplemented skeleton shell (${shell.join('; ')}); implementation ` +
              'belongs after spec_commit',
          );
        }
        continue;
      }
      problems.push(
        `${path}: changed in a rule-test commit (before spec_commit) outside the rule-test ` +
          "author's paths (rule-test assets, the ops/tasks/** ledger, NotImplemented skeleton " +
          'shells inside the task paths)',
      );
    }
  }
  return problems;
}

/**
 * The path guard of a rule-test RUN (Codex writing the rule tests, tools/agent/post-run.sh with
 * `path-guard.ts --author`; default split of 2026-10-05, ops/approvals.yaml id 19): the working
 * tree against the branch point, before anything is committed. Same three kinds of paths as the
 * rule-test commits above; `contentAtSpec` reads the working tree. Out-of-scope `ops/` and
 * `docs/` changes are listed apart and do not fail (the orchestrator reverts them), as in the
 * implementer's path guard; the ledger `ops/tasks/**` is the orchestrator's, also reverted.
 */
export function checkAuthorPaths(
  changes: readonly Change[],
  scope: AuthorScope,
  protectedHits: readonly ProtectedHit[],
): PathGuardResult {
  const violations: { path: string; reason: string }[] = [];
  const opsDocs = new Set<string>();
  const seen = new Set<string>();
  for (const change of changes) {
    const sides: [string, boolean][] = [[change.path, change.status === 'D']];
    if (change.oldPath !== undefined) sides.push([change.oldPath, true]);
    for (const [path, removed] of sides) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (matchesAny(path, scope.testAssets)) continue;
      if (matchesAny(path, scope.taskPaths)) {
        if (removed) {
          violations.push({
            path,
            reason: 'removed in a rule-test run; the rule-test author only adds skeleton shells',
          });
          continue;
        }
        const shell = shellProblems(path, scope);
        if (shell.length > 0) {
          violations.push({
            path,
            reason:
              'implementation in a rule-test run: a file inside the task paths must be a ' +
              `NotImplemented skeleton shell (${shell.join('; ')})`,
          });
        }
        continue;
      }
      if (path.startsWith('ops/') || path.startsWith('docs/')) {
        opsDocs.add(path);
        continue;
      }
      violations.push({
        path,
        reason:
          "outside the rule-test author's paths (the task's test_paths, NotImplemented skeleton " +
          'shells inside the task paths)',
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    out_of_scope_ops_docs: [...opsDocs].sort(),
    protected_hits: protectedHits.map((h) => ({ path: h.path, class: h.class })),
  };
}

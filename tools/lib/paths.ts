// Well-known locations (conventions C7, C9; 规划/11 §0). Everything is an absolute path.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function envPath(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : resolve(value);
}

/** Marker file at the top of the run-state directory (written by the orchestrator, never in a repo). */
export const RUNS_MARKER = 'HANDOFF.md';

/**
 * The run-state directory that holds the checkout at `root`, found on disk (D10-222): walking up
 * from the checkout's parent, the first directory named `couli-runs` that contains RUNS_MARKER,
 * or the first one with a `couli-runs/RUNS_MARKER` child. This covers `<projects>/rebate-platform`
 * (sibling), `<runs>/worktrees/<id>`, `<runs>/trusted/<name>` and the lane clones in
 * `<runs>/clones/<name>`. null when there is none (a CI runner, a fresh machine).
 */
export function findRunsDir(root: string): string | null {
  for (let dir = dirname(resolve(root)); ;) {
    if (basename(dir) === 'couli-runs' && existsSync(join(dir, RUNS_MARKER))) return dir;
    if (existsSync(join(dir, 'couli-runs', RUNS_MARKER))) return join(dir, 'couli-runs');
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Default layout for a checkout at `root`: the run-state directory found by findRunsDir and the
 * projects directory that holds it (the planning repository is `<projects>/couli`). With no
 * run-state directory on disk, `runs` is null and `projects` is the checkout's parent.
 */
export function layoutFor(root: string): { runs: string | null; projects: string } {
  const runs = findRunsDir(root);
  return runs === null
    ? { runs, projects: dirname(resolve(root)) }
    : { runs, projects: dirname(runs) };
}

/** The checkout this script was loaded from (the directory that contains `tools/`). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** `COULI_RUNS`, else the run-state directory found on disk, else null (no error). */
function runsDirOrNull(): string | null {
  return envPath('COULI_RUNS') ?? layoutFor(repoRoot()).runs;
}

/**
 * Run-state directory outside any repository: `COULI_RUNS`, else the `couli-runs` directory
 * found above this checkout (findRunsDir). With neither it is an error, never a guessed path:
 * a guess such as `<clones>/couli-runs` silently splits the in-flight state (D10-222).
 */
export function runsDir(): string {
  const runs = runsDirOrNull();
  if (runs === null) {
    throw new Error(
      `no run-state directory for ${repoRoot()}: set COULI_RUNS, or keep the checkout under a ` +
        `couli-runs directory (or next to one) that contains ${RUNS_MARKER}`,
    );
  }
  return runs;
}

/** Planning repository: `COULI_SPEC_REPO`, default `<REPO>/../couli`. */
export function specRepo(): string {
  return envPath('COULI_SPEC_REPO') ?? join(layoutFor(repoRoot()).projects, 'couli');
}

/** Trimmed content of `<REPO>/SPEC_REF` (the planning commit this code corresponds to). */
export function specRef(): string {
  const file = join(repoRoot(), 'SPEC_REF');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`SPEC_REF not found at ${file}`);
  }
  return text.trim();
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * True when `dir` is a task worktree: `<runs>/worktrees/<id>` (by the runs directory in use,
 * and by the layout of the path itself, so a worktree is recognised even when COULI_RUNS points
 * elsewhere). A worktree is the Codex sandbox's writable root and can never hold gates.
 */
export function isTaskWorktree(dir: string, runs: string | null = runsDirOrNull()): boolean {
  const path = resolve(dir);
  if (runs !== null && isUnder(path, join(runs, 'worktrees')) && path !== join(runs, 'worktrees')) {
    return true;
  }
  // Any ancestor of the shape .../couli-runs/worktrees/<id>.
  for (let p = path; ;) {
    const parent = dirname(p);
    if (basename(parent) === 'worktrees' && basename(dirname(parent)) === 'couli-runs') return true;
    if (parent === p) return false;
    p = parent;
  }
}

/**
 * Where gates (guards, schemas, prompts, risk map, approvals) are read from (规划/11 §2.4):
 * `COULI_TRUSTED_ROOT`, else the trusted copy `<runs>/trusted/rebate-platform` once it exists,
 * else this checkout — but never a task worktree. Running the tools from
 * `<runs>/worktrees/<id>` without an explicit COULI_TRUSTED_ROOT is an error, so a branch under
 * test cannot silently become the source of its own guards.
 */
export function trustedRoot(): string {
  const fromEnv = envPath('COULI_TRUSTED_ROOT');
  if (fromEnv) {
    if (isTaskWorktree(fromEnv)) {
      throw new Error(
        `COULI_TRUSTED_ROOT points into a task worktree (${fromEnv}); gates are never read ` +
          'from the branch under test (规划/11 §2.4)',
      );
    }
    return fromEnv;
  }
  // No run-state directory (a CI runner): there is no trusted copy either, this checkout is used.
  const runs = runsDirOrNull();
  const copy = runs === null ? null : join(runs, 'trusted', 'rebate-platform');
  if (copy !== null && existsSync(join(copy, 'tools', 'guard'))) return copy;
  const self = repoRoot();
  if (isTaskWorktree(self)) {
    throw new Error(
      `${self} is a task worktree: run the tools from the main checkout or the trusted copy, ` +
        'or set COULI_TRUSTED_ROOT (规划/11 §2.4: gates are never read from the branch under test)',
    );
  }
  return self;
}

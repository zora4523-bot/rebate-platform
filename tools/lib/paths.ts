// Well-known locations (conventions C7, C9; 规划/11 §0). Everything is an absolute path.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function envPath(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : resolve(value);
}

/**
 * Default sibling layout for a checkout at `root`.
 * A normal checkout `<projects>/rebate-platform` has its run state in `<projects>/couli-runs`.
 * A task worktree `<runs>/worktrees/<id>` or the trusted copy `<runs>/trusted/<name>` lives
 * inside the run-state directory, so the defaults are derived from that directory instead.
 */
export function layoutFor(root: string): { runs: string; projects: string } {
  const parent = dirname(root);
  const kind = basename(parent);
  if (kind === 'worktrees' || kind === 'trusted') {
    const runs = dirname(parent);
    return { runs, projects: dirname(runs) };
  }
  return { runs: join(parent, 'couli-runs'), projects: parent };
}

/** The checkout this script was loaded from (the directory that contains `tools/`). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Run-state directory outside any repository: `COULI_RUNS`, default `<REPO>/../couli-runs`. */
export function runsDir(): string {
  return envPath('COULI_RUNS') ?? layoutFor(repoRoot()).runs;
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
export function isTaskWorktree(dir: string, runs: string = runsDir()): boolean {
  const path = resolve(dir);
  if (isUnder(path, join(runs, 'worktrees')) && path !== join(runs, 'worktrees')) return true;
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
  const copy = join(runsDir(), 'trusted', 'rebate-platform');
  if (existsSync(join(copy, 'tools', 'guard'))) return copy;
  const self = repoRoot();
  if (isTaskWorktree(self)) {
    throw new Error(
      `${self} is a task worktree: run the tools from the main checkout or the trusted copy, ` +
        'or set COULI_TRUSTED_ROOT (规划/11 §2.4: gates are never read from the branch under test)',
    );
  }
  return self;
}

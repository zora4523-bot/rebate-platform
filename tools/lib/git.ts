// Thin, read-oriented git helpers. Nothing here commits, pushes or switches branches:
// the orchestrator is the only git writer (规划/11 §0 rule 2).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MAX_BUFFER = 256 * 1024 * 1024;

// Variables git sets while running hooks; they would redirect commands aimed at another
// repository or work tree, so they are never inherited.
const LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARS) delete env[name];
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

export type GitResult = { status: number; stdout: string; stderr: string };

export class GitError extends Error {
  readonly status: number;
  readonly stderr: string;

  constructor(args: readonly string[], status: number, stderr: string) {
    super(`git ${args.join(' ')} failed with exit code ${status}: ${stderr.trim()}`);
    this.name = 'GitError';
    this.status = status;
    this.stderr = stderr;
  }
}

/** Runs git and returns exit status and raw output; throws only when git cannot be started. */
export function tryGit(args: readonly string[], opts: { cwd?: string } = {}): GitResult {
  const res = spawnSync('git', [...args], {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    env: gitEnv(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && opts.cwd !== undefined && !existsSync(opts.cwd)) {
      throw new Error(
        `cannot run git ${args.join(' ')}: directory does not exist: ${opts.cwd} ` +
          '(a planning repository is located through COULI_SPEC_REPO, default <REPO>/../couli)',
      );
    }
    throw new Error(`cannot run git ${args.join(' ')}: ${res.error.message}`);
  }
  return { status: res.status ?? 128, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Runs git and returns stdout with trailing newlines removed (NUL-separated `-z` output is
 * returned untouched). Throws GitError on a non-zero exit. Use showFile() for exact file bytes.
 */
export function git(args: readonly string[], opts: { cwd?: string } = {}): string {
  const res = tryGit(args, opts);
  if (res.status !== 0) throw new GitError(args, res.status, res.stderr);
  return res.stdout.replace(/[\r\n]+$/, '');
}

export type Change = { path: string; status: 'A' | 'M' | 'D' | 'R' | '?'; oldPath?: string };

function assertRef(ref: string): void {
  if (ref === '' || ref.startsWith('-')) throw new Error(`invalid git ref: "${ref}"`);
}

/**
 * Files that differ between `base` and the working tree (staged and unstaged), plus untracked
 * files that are not ignored (status `?`). Renames are reported as `R` with `oldPath`.
 * Paths are repo-relative POSIX paths, never quoted or escaped.
 */
export function changedFiles(base: string, opts: { cwd?: string } = {}): Change[] {
  assertRef(base);
  const changes: Change[] = [];
  const diff = git(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--no-ext-diff',
      base,
      '--',
    ],
    opts,
  );
  const fields = diff.split('\0');
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = fields[i++] ?? '';
      const path = fields[i++] ?? '';
      // A copy leaves its source untouched, so only the new file is a change.
      changes.push(code === 'R' ? { path, status: 'R', oldPath } : { path, status: 'A' });
    } else {
      const path = fields[i++] ?? '';
      changes.push({ path, status: code === 'A' || code === 'D' ? code : 'M' });
    }
  }
  const untracked = git(
    ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard'],
    opts,
  );
  for (const path of untracked.split('\0')) {
    if (path !== '') changes.push({ path, status: '?' });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Exact content of `<ref>:<path>` in the repository at `repoDir`; throws when it does not exist. */
export function showFile(repoDir: string, ref: string, path: string): string {
  assertRef(ref);
  const args = ['-C', repoDir, 'show', `${ref}:${path}`];
  const res = tryGit(args);
  if (res.status !== 0) throw new GitError(args, res.status, res.stderr);
  return res.stdout;
}

/** True when `<ref>:<path>` exists as a blob or tree. */
export function existsAt(repoDir: string, ref: string, path: string): boolean {
  assertRef(ref);
  return tryGit(['-C', repoDir, 'cat-file', '-e', `${ref}:${path}`]).status === 0;
}

/** Recursive file list of `<ref>` below `prefix` (repo-relative POSIX paths). */
export function listTree(repoDir: string, ref: string, prefix: string): string[] {
  assertRef(ref);
  const out = git([
    '-C',
    repoDir,
    '-c',
    'core.quotepath=false',
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    ref,
    '--',
    prefix,
  ]);
  return out.split('\0').filter((p) => p !== '');
}

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';

// The fixture sits under REPO/.tmp. Every shim used here is a copy inside a fake project
// layout, so the guarded directories are the fake ones, not this repository.
const SHIM = join(repoRoot(), 'tools', 'guard', 'shim', 'codex');
let base = '';
let repo = '';
let runs = '';
let other = '';
let realBin = '';
let repoShim = '';
let trustedShim = '';

const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'printf "REAL\\n"',
  'for arg in "$@"; do printf "ARG:%s\\n" "$arg"; done',
  '',
].join('\n');

function installShim(root: string): string {
  const dir = join(root, 'tools', 'guard', 'shim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'SPEC_REF'), `${'a'.repeat(40)}\n`);
  const target = join(dir, 'codex');
  copyFileSync(SHIM, target);
  chmodSync(target, 0o755);
  return target;
}

function run(
  shim: string,
  args: string[],
  opts: { cwd: string; path?: string[]; env?: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
  const path = opts.path ?? [join(shim, '..'), realBin];
  const res = spawnSync(shim, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: {
      PATH: [...path, '/usr/bin', '/bin'].join(':'),
      HOME: process.env['HOME'] ?? '/',
      ...opts.env,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
  mkdirSync(join(repoRoot(), '.tmp'), { recursive: true });
  base = mkdtempSync(join(repoRoot(), '.tmp', 'shim-test-'));
  repo = join(base, '我的 项目', 'rebate-platform');
  runs = join(base, '我的 项目', 'couli-runs');
  other = join(base, '我的 项目', 'other-project');
  realBin = join(base, 'real-bin');
  mkdirSync(join(repo, 'apps', 'api'), { recursive: true });
  mkdirSync(join(runs, 'worktrees', 'B2-03a', 'packages'), { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(realBin, { recursive: true });
  writeFileSync(join(realBin, 'codex'), FAKE_CODEX);
  chmodSync(join(realBin, 'codex'), 0o755);
  repoShim = installShim(repo);
  trustedShim = installShim(join(runs, 'trusted', 'rebate-platform'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('codex shim', () => {
  it('is executable and has valid bash syntax', () => {
    expect(statSync(SHIM).mode & 0o111).not.toBe(0);
    expect(spawnSync('bash', ['-n', SHIM]).status).toBe(0);
  });

  it('passes through untouched outside the project', () => {
    const res = run(repoShim, ['exec', '--json', 'two words', '中文 参数', ''], { cwd: other });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('REAL\nARG:exec\nARG:--json\nARG:two words\nARG:中文 参数\nARG:\n');
    expect(res.stderr).toBe('');
  });

  it.each([
    ['the repository root', () => repo],
    ['a subdirectory of the repository', () => join(repo, 'apps', 'api')],
    ['a task worktree', () => join(runs, 'worktrees', 'B2-03a')],
    ['a subdirectory of a task worktree', () => join(runs, 'worktrees', 'B2-03a', 'packages')],
    ['the trusted copy', () => join(runs, 'trusted', 'rebate-platform')],
  ])('refuses in %s without the wrapper marker', (_name, dir) => {
    const res = run(repoShim, ['exec', 'hello'], { cwd: dir() });
    expect(res.status).toBe(126);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('已拒绝');
    expect(res.stderr).toContain('tools/agent/codex-run.sh');
  });

  it.each([
    ['-C <dir>', () => ['exec', '-C', repo, 'hello']],
    ['--cd <dir>', () => ['exec', '--cd', join(runs, 'worktrees', 'B2-03a'), 'hello']],
    ['--cd=<dir>', () => ['exec', `--cd=${repo}`, 'hello']],
    ['-C<dir>', () => ['exec', `-C${repo}`, 'hello']],
    ['a relative -C', () => ['exec', '-C', '../rebate-platform/apps', 'hello']],
    ['a -C target that does not exist yet', () => ['exec', '-C', join(repo, 'new-dir'), 'hello']],
  ])('refuses when %s points into the project', (_name, args) => {
    const res = run(repoShim, args(), { cwd: other });
    expect(res.status).toBe(126);
    expect(res.stdout).toBe('');
  });

  it('does not treat text after "--" as options', () => {
    const res = run(repoShim, ['exec', '--', '-C', repo], { cwd: other });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('REAL');
  });

  it('lets the wrapper through inside the project', () => {
    const res = run(repoShim, ['exec', '-C', repo, '-s', 'workspace-write', 'a b'], {
      cwd: repo,
      env: { COULI_CODEX_WRAPPER: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      `REAL\nARG:exec\nARG:-C\nARG:${repo}\nARG:-s\nARG:workspace-write\nARG:a b\n`,
    );
  });

  it('accepts only the exact marker value', () => {
    const res = run(repoShim, ['exec', 'x'], { cwd: repo, env: { COULI_CODEX_WRAPPER: 'true' } });
    expect(res.status).toBe(126);
  });

  it('answers --version and --help inside the project', () => {
    expect(run(repoShim, ['--version'], { cwd: repo }).stdout).toBe('REAL\nARG:--version\n');
    expect(run(repoShim, ['-h'], { cwd: repo }).status).toBe(0);
    expect(run(repoShim, ['--version', 'exec'], { cwd: repo }).status).toBe(126);
  });

  it('finds the real codex whether it comes before or after the shim on PATH', () => {
    const shimDir = join(repoShim, '..');
    const after = run(repoShim, ['x'], { cwd: other, path: [shimDir, realBin] });
    const before = run(repoShim, ['x'], { cwd: other, path: [realBin, shimDir] });
    expect(after.stdout).toBe('REAL\nARG:x\n');
    expect(before.stdout).toBe('REAL\nARG:x\n');
  });

  it('never calls itself: exit 127 when no other codex is on PATH', () => {
    const shimDir = join(repoShim, '..');
    const linkDir = join(base, 'link-bin');
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(repoShim, join(linkDir, 'codex'));
    const res = run(repoShim, ['x'], { cwd: other, path: [shimDir, linkDir] });
    expect(res.status).toBe(127);
    expect(res.stderr).toContain('找不到真正的 codex');
  });

  it('works when started through a symlink', () => {
    const linkDir = join(base, 'link-bin-2');
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, 'codex');
    symlinkSync(repoShim, link);
    expect(run(link, ['exec'], { cwd: repo, path: [linkDir, realBin] }).status).toBe(126);
    expect(run(link, ['exec'], { cwd: other, path: [linkDir, realBin] }).stdout).toBe(
      'REAL\nARG:exec\n',
    );
  });

  it('guards the main checkout and the worktrees when it runs from the trusted copy', () => {
    expect(run(trustedShim, ['exec'], { cwd: repo }).status).toBe(126);
    expect(run(trustedShim, ['exec'], { cwd: join(runs, 'worktrees', 'B2-03a') }).status).toBe(126);
    expect(run(trustedShim, ['exec'], { cwd: other }).status).toBe(0);
  });

  it('honours COULI_SHIM_GUARD_DIRS instead of the derived directories', () => {
    const env = { COULI_SHIM_GUARD_DIRS: `${other}:/nonexistent/dir` };
    expect(run(repoShim, ['exec'], { cwd: other, env }).status).toBe(126);
    expect(run(repoShim, ['exec'], { cwd: repo, env }).status).toBe(0);
  });

  it('warns and passes through when it was copied out of the repository', () => {
    const strayDir = join(base, 'a', 'b', 'c', 'stray');
    mkdirSync(strayDir, { recursive: true });
    const stray = join(strayDir, 'codex');
    copyFileSync(SHIM, stray);
    chmodSync(stray, 0o755);
    const res = run(stray, ['exec'], { cwd: repo, path: [strayDir, realBin] });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('REAL\nARG:exec\n');
    expect(res.stderr).toContain('未启用保护');
  });
});

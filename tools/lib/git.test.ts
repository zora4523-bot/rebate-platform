import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitError, changedFiles, existsAt, git, listTree, showFile, tryGit } from './git.ts';
import { repoRoot } from './paths.ts';

// Fixture repositories live under REPO/.tmp (git-ignored), never under the system temp dir:
// that directory is a writable root of the Codex sandbox (规划/11 §0).
const scratchParent = join(repoRoot(), '.tmp');
let repo = '';
let base = '';

function run(args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
}

function write(path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

beforeAll(() => {
  mkdirSync(scratchParent, { recursive: true });
  repo = mkdtempSync(join(scratchParent, 'git-test-'));
  run(['init', '-q', '-b', 'main']);
  write('.gitignore', 'ignored/\n');
  write('keep.txt', 'keep\n');
  write('modify.txt', 'one\n');
  write('delete me.txt', 'bye\n');
  write('old/名称 旧.md', '# 一个足够长的标题，让重命名检测可以认出它\n正文第一行\n正文第二行\n');
  write('规划/08 规则.md', 'spec\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
  base = run(['rev-parse', 'HEAD']).trim();
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git', () => {
  it('returns stdout without the trailing newline', () => {
    expect(git(['rev-parse', 'HEAD'], { cwd: repo })).toBe(base);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).toBe('main');
  });

  it('throws GitError with status and stderr on failure', () => {
    let caught: unknown;
    try {
      git(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitError);
    expect((caught as GitError).status).not.toBe(0);
    expect((caught as GitError).message).toContain('rev-parse');
  });

  it('exposes the exit status through tryGit', () => {
    expect(tryGit(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: repo }).status).toBe(0);
    expect(tryGit(['cat-file', '-e', 'HEAD:missing'], { cwd: repo }).status).not.toBe(0);
  });

  it('ignores GIT_DIR and friends inherited from a hook environment', () => {
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = '/nonexistent/.git';
    try {
      expect(git(['rev-parse', 'HEAD'], { cwd: repo })).toBe(base);
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }
  });
});

describe('showFile, existsAt, listTree', () => {
  it('returns exact content for paths with spaces and Chinese characters', () => {
    expect(showFile(repo, base, '规划/08 规则.md')).toBe('spec\n');
    expect(showFile(repo, 'HEAD', 'delete me.txt')).toBe('bye\n');
  });

  it('throws for a missing path and rejects option-like refs', () => {
    expect(() => showFile(repo, base, 'missing.txt')).toThrow(GitError);
    expect(() => showFile(repo, '--output=/dev/null', 'keep.txt')).toThrow(/invalid git ref/);
  });

  it('checks existence and lists a tree without quoting', () => {
    expect(existsAt(repo, base, '规划/08 规则.md')).toBe(true);
    expect(existsAt(repo, base, '规划/missing.md')).toBe(false);
    expect(listTree(repo, base, '规划')).toEqual(['规划/08 规则.md']);
    expect(listTree(repo, base, 'old')).toEqual(['old/名称 旧.md']);
  });
});

describe('changedFiles', () => {
  it('reports nothing for a clean tree', () => {
    expect(changedFiles(base, { cwd: repo })).toEqual([]);
  });

  it('reports modified, deleted, renamed, added and untracked files', () => {
    write('modify.txt', 'two\n');
    rmSync(join(repo, 'delete me.txt'));
    mkdirSync(join(repo, 'new dir'), { recursive: true });
    renameSync(join(repo, 'old/名称 旧.md'), join(repo, 'new dir/名称 新.md'));
    run(['add', '-A', 'old', 'new dir']);
    write('staged 新增.ts', 'export {};\n');
    run(['add', 'staged 新增.ts']);
    write('untracked/深 层/文件 a.txt', 'x\n');
    write('ignored/secret.txt', 'never listed\n');

    expect(changedFiles(base, { cwd: repo })).toEqual([
      { path: 'delete me.txt', status: 'D' },
      { path: 'modify.txt', status: 'M' },
      { path: 'new dir/名称 新.md', status: 'R', oldPath: 'old/名称 旧.md' },
      { path: 'staged 新增.ts', status: 'A' },
      { path: 'untracked/深 层/文件 a.txt', status: '?' },
    ]);
  });

  it('compares against the given base, not only against HEAD', () => {
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'second']);
    expect(changedFiles('HEAD', { cwd: repo })).toEqual([]);
    expect(changedFiles(base, { cwd: repo }).map((c) => c.path)).toContain('modify.txt');
  });

  it('rejects option-like refs', () => {
    expect(() => changedFiles('--cached', { cwd: repo })).toThrow(/invalid git ref/);
  });
});

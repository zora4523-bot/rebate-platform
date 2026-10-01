import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isTaskWorktree,
  layoutFor,
  repoRoot,
  runsDir,
  specRef,
  specRepo,
  trustedRoot,
} from './paths.ts';

const VARS = ['COULI_RUNS', 'COULI_SPEC_REPO', 'COULI_TRUSTED_ROOT'] as const;
const saved = new Map<string, string | undefined>();
let scratch = '';

beforeEach(() => {
  for (const name of VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  scratch = mkdtempSync(join(tmpdir(), 'couli-paths-'));
});

afterEach(() => {
  for (const name of VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('paths', () => {
  it('finds the checkout that contains tools/lib', () => {
    const root = repoRoot();
    expect(existsSync(join(root, 'tools', 'lib', 'paths.ts'))).toBe(true);
    expect(root).toBe(resolve(import.meta.dirname, '..', '..'));
  });

  it('defaults to sibling directories of the checkout', () => {
    const root = repoRoot();
    expect(runsDir()).toBe(resolve(root, '..', 'couli-runs'));
    expect(specRepo()).toBe(resolve(root, '..', 'couli'));
  });

  it('derives the layout of worktrees and of the trusted copy from the runs directory', () => {
    expect(layoutFor('/p/rebate-platform')).toEqual({ runs: '/p/couli-runs', projects: '/p' });
    expect(layoutFor('/p/couli-runs/worktrees/B2-03a')).toEqual({
      runs: '/p/couli-runs',
      projects: '/p',
    });
    expect(layoutFor('/p/couli-runs/trusted/rebate-platform')).toEqual({
      runs: '/p/couli-runs',
      projects: '/p',
    });
  });

  it('honours COULI_RUNS and COULI_SPEC_REPO, resolving relative values', () => {
    process.env['COULI_RUNS'] = join(scratch, 'runs');
    process.env['COULI_SPEC_REPO'] = 'relative-spec';
    expect(runsDir()).toBe(join(scratch, 'runs'));
    expect(specRepo()).toBe(resolve('relative-spec'));
  });

  it('treats empty variables as unset', () => {
    process.env['COULI_RUNS'] = '';
    expect(runsDir()).toBe(resolve(repoRoot(), '..', 'couli-runs'));
  });

  it('uses this checkout as trusted root until the trusted copy exists', () => {
    process.env['COULI_RUNS'] = join(scratch, 'runs');
    expect(trustedRoot()).toBe(repoRoot());
    const copy = join(scratch, 'runs', 'trusted', 'rebate-platform');
    mkdirSync(join(copy, 'tools', 'guard'), { recursive: true });
    expect(trustedRoot()).toBe(copy);
  });

  it('never accepts a task worktree as the trusted root (规划/11 §2.4)', () => {
    process.env['COULI_RUNS'] = join(scratch, 'runs');
    expect(isTaskWorktree(join(scratch, 'runs', 'worktrees', 'B2-03a'))).toBe(true);
    expect(isTaskWorktree('/p/couli-runs/worktrees/B2-03a')).toBe(true);
    expect(isTaskWorktree('/p/couli-runs/worktrees/B2-03a/tools')).toBe(true);
    expect(isTaskWorktree(join(scratch, 'runs', 'worktrees'))).toBe(false);
    expect(isTaskWorktree('/p/couli-runs/trusted/rebate-platform')).toBe(false);
    expect(isTaskWorktree('/p/rebate-platform')).toBe(false);
    process.env['COULI_TRUSTED_ROOT'] = join(scratch, 'runs', 'worktrees', 'B2-03a');
    expect(() => trustedRoot()).toThrow(/task worktree/);
  });

  it('lets COULI_TRUSTED_ROOT override everything', () => {
    process.env['COULI_RUNS'] = join(scratch, 'runs');
    mkdirSync(join(scratch, 'runs', 'trusted', 'rebate-platform', 'tools', 'guard'), {
      recursive: true,
    });
    process.env['COULI_TRUSTED_ROOT'] = join(scratch, 'elsewhere');
    expect(trustedRoot()).toBe(join(scratch, 'elsewhere'));
  });

  it('reads SPEC_REF without surrounding whitespace when the file exists', () => {
    if (!existsSync(join(repoRoot(), 'SPEC_REF'))) {
      expect(() => specRef()).toThrow(/SPEC_REF not found/);
      return;
    }
    const ref = specRef();
    expect(ref).toBe(ref.trim());
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });
});

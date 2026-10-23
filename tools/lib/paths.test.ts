import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findRunsDir,
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

  /** A run-state directory with its marker under `scratch`, plus the given checkout dirs. */
  function layout(...dirs: string[]): { p: string; runs: string } {
    const p = join(scratch, 'p');
    const runs = join(p, 'couli-runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, 'HANDOFF.md'), '# handoff\n');
    for (const dir of dirs) mkdirSync(join(p, dir), { recursive: true });
    return { p, runs };
  }

  it('without COULI_RUNS uses the run-state directory found above the checkout, or fails', () => {
    const root = repoRoot();
    const found = findRunsDir(root);
    if (found === null) {
      expect(() => runsDir()).toThrow(/no run-state directory .*COULI_RUNS/);
      expect(specRepo()).toBe(resolve(root, '..', 'couli'));
    } else {
      expect(runsDir()).toBe(found);
      expect(specRepo()).toBe(join(dirname(found), 'couli'));
    }
  });

  it('finds the run-state directory of a sibling checkout, a worktree, the trusted copy and a lane clone (D10-222)', () => {
    const { p, runs } = layout(
      'rebate-platform',
      'couli-runs/worktrees/B2-03a',
      'couli-runs/trusted/rebate-platform',
      'couli-runs/clones/rebate-platform-ops',
      // A directory left behind by the old guess, without the marker: never taken.
      'couli-runs/clones/couli-runs/state',
    );
    expect(findRunsDir(join(p, 'rebate-platform'))).toBe(runs);
    expect(findRunsDir(join(runs, 'worktrees', 'B2-03a'))).toBe(runs);
    expect(findRunsDir(join(runs, 'trusted', 'rebate-platform'))).toBe(runs);
    expect(findRunsDir(join(runs, 'clones', 'rebate-platform-ops'))).toBe(runs);
    expect(layoutFor(join(runs, 'clones', 'rebate-platform-ops'))).toEqual({ runs, projects: p });
    expect(layoutFor(join(p, 'rebate-platform'))).toEqual({ runs, projects: p });
  });

  it('finds nothing without the marker, and then guesses no path', () => {
    const lone = join(scratch, 'q', 'rebate-platform');
    mkdirSync(join(scratch, 'q', 'couli-runs'), { recursive: true });
    mkdirSync(lone, { recursive: true });
    expect(findRunsDir(lone)).toBeNull();
    expect(layoutFor(lone)).toEqual({ runs: null, projects: join(scratch, 'q') });
  });

  it('judges a task worktree by the shape of its path when there is no run-state directory', () => {
    expect(isTaskWorktree('/x/couli-runs/worktrees/B2-03a', null)).toBe(true);
    expect(isTaskWorktree('/x/couli-runs/clones/rebate-platform-ops', null)).toBe(false);
  });

  it('honours COULI_RUNS and COULI_SPEC_REPO, resolving relative values', () => {
    process.env['COULI_RUNS'] = join(scratch, 'runs');
    process.env['COULI_SPEC_REPO'] = 'relative-spec';
    expect(runsDir()).toBe(join(scratch, 'runs'));
    expect(specRepo()).toBe(resolve('relative-spec'));
  });

  it('treats empty variables as unset', () => {
    process.env['COULI_RUNS'] = '';
    const found = findRunsDir(repoRoot());
    if (found === null) expect(() => runsDir()).toThrow(/COULI_RUNS/);
    else expect(runsDir()).toBe(found);
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

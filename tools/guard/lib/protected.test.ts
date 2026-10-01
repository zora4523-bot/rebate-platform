import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonFile } from '../../lib/fsx.ts';
import type { Change } from '../../lib/git.ts';
import { repoRoot } from '../../lib/paths.ts';
import {
  classOfPath,
  covers,
  findProtectedHits,
  loadProtected,
  parseProtected,
  splitFragment,
} from './protected.ts';
import type { ContentReaders, ProtectedConfig } from './protected.ts';

// The single source for 规划/11 §4.4 (conventions C10).
const EXPECTED: ProtectedConfig = {
  class1_add_only: [
    'test/spec/**',
    'test/acceptance/**',
    'test/properties/**',
    'test/replay/**',
    'packages/testing/**',
    'db/invariants/**',
    'specs/commission-examples.csv',
    'test-manifest.json',
  ],
  class2_verify_config: [
    '**/vitest*.config.*',
    'vitest.shared.ts',
    '**/stryker.config.*',
    '**/eslint.config.*',
    '.dependency-cruiser.cjs',
    'turbo.json',
    '.npmrc',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '**/package.json#scripts',
    'tsconfig*.json',
    '**/tsconfig*.json',
    '.prettierrc*',
    '.prettierignore',
    '.editorconfig',
    'contracts/redocly.yaml',
    'contracts/.redocly.lint-ignore.yaml',
  ],
  class3_gates: [
    'tools/**',
    '.github/**',
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '**/AGENTS.override.md',
    '**/CLAUDE.local.md',
    '.claude/**',
    '.codex/**',
    '.mcp.json',
    'ops/risk-map.yaml',
    'ops/approvals.yaml',
    'ops/branch-protection.json',
    '.githooks/**',
    '.gitleaks.toml',
    'SPEC_REF',
    '.gitignore',
    '.gitattributes',
    'packages/db/scripts/snapshot.ts',
    'packages/db/scripts/gen-pgboss-migration.ts',
    '**/scripts/*check*',
  ],
};

const cfg = EXPECTED;

function readers(base: Record<string, string>, work: Record<string, string>): ContentReaders {
  return {
    readBase: (path) => base[path] ?? null,
    readWork: (path) => work[path] ?? null,
  };
}

const NO_CONTENT = readers({}, {});

function hitsOf(changes: Change[], r: ContentReaders = NO_CONTENT, taskType?: string): string[] {
  return findProtectedHits(changes, cfg, r, { taskType }).map((h) => `${h.class}:${h.path}`);
}

describe('protected-paths.json', () => {
  it('is exactly the list agreed in the conventions', () => {
    const file = join(repoRoot(), 'tools', 'guard', 'protected-paths.json');
    expect(readJsonFile(file)).toEqual(EXPECTED);
    expect(loadProtected(repoRoot())).toEqual(EXPECTED);
  });

  it('rejects malformed configuration', () => {
    expect(() => parseProtected([])).toThrow(/must be an object/);
    expect(() => parseProtected({ ...EXPECTED, extra: [] })).toThrow(/unknown keys extra/);
    expect(() => parseProtected({ ...EXPECTED, class3_gates: [] })).toThrow(/class3_gates/);
    expect(() => parseProtected({ ...EXPECTED, class1_add_only: ['a/{b'] })).toThrow(/unbalanced/);
  });
});

describe('splitFragment', () => {
  it('separates the JSON key from the glob', () => {
    expect(splitFragment('**/package.json#scripts')).toEqual({
      glob: '**/package.json',
      fragment: 'scripts',
    });
    expect(splitFragment('tools/**')).toEqual({ glob: 'tools/**', fragment: null });
  });
});

describe('covers', () => {
  it('matches literal inputs directly', () => {
    expect(covers('tools/**', 'tools/guard/run.ts')).toBe(true);
    expect(covers('tools/**', 'docs/a.md')).toBe(false);
  });

  it('accepts a glob input only when it lies inside a directory rule', () => {
    expect(covers('packages/money/**', 'packages/money/src/**')).toBe(true);
    expect(covers('packages/money/**', 'packages/money/**')).toBe(true);
    expect(covers('packages/money/**', 'packages/**')).toBe(false);
    expect(covers('packages/money/**', 'packages/mon*/**')).toBe(false);
    expect(covers('packages/money/**', 'packages/money*/x')).toBe(false);
    expect(covers('**/AGENTS.md', 'packages/money/**')).toBe(false);
    expect(covers('**', 'anything/**')).toBe(true);
  });
});

describe('classOfPath', () => {
  it('returns the class of literal paths, the highest one when several match', () => {
    expect(classOfPath('test/spec/money/round.test.ts', cfg)).toBe(1);
    expect(classOfPath('turbo.json', cfg)).toBe(2);
    expect(classOfPath('apps/api/package.json', cfg)).toBe(2);
    expect(classOfPath('package.json', cfg)).toBe(2);
    expect(classOfPath('tools/guard/run.ts', cfg)).toBe(3);
    expect(classOfPath('apps/api/AGENTS.md', cfg)).toBe(3);
    expect(classOfPath('packages/testing/vitest.config.ts', cfg)).toBe(2);
    expect(classOfPath('packages/testing/AGENTS.md', cfg)).toBe(3);
    expect(classOfPath('packages/money/src/index.ts', cfg)).toBeNull();
    expect(classOfPath('ops/tasks/B2-03.yaml', cfg)).toBeNull();
  });

  it('is case-insensitive, because the working tree may be', () => {
    expect(classOfPath('apps/api/agents.md', cfg)).toBe(3);
    expect(classOfPath('.Claude/settings.json', cfg)).toBe(3);
    expect(classOfPath('Turbo.JSON', cfg)).toBe(2);
  });

  it('classifies a task glob only when it lies inside a protected area', () => {
    expect(classOfPath('tools/guard/**', cfg)).toBe(3);
    expect(classOfPath('test/spec/ledger/**', cfg)).toBe(1);
    expect(classOfPath('packages/money/**', cfg)).toBeNull();
    expect(classOfPath('apps/api/src/modules/health/**', cfg)).toBeNull();
  });
});

describe('findProtectedHits', () => {
  it('lets class-1 files be added but not modified, deleted or renamed', () => {
    expect(
      hitsOf([
        { path: 'test/spec/money/new.test.ts', status: '?' },
        { path: 'test/properties/added.test.ts', status: 'A' },
        { path: 'packages/testing/src/fake-clock.ts', status: 'A' },
      ]),
    ).toEqual([]);
    expect(
      hitsOf([
        { path: 'test/spec/money/round.test.ts', status: 'M' },
        { path: 'db/invariants/ledger_invariants.sql', status: 'D' },
        { path: 'test/unit/moved.test.ts', status: 'R', oldPath: 'test/acceptance/old.test.ts' },
        { path: 'specs/commission-examples.csv', status: 'M' },
      ]),
    ).toEqual([
      '1:db/invariants/ledger_invariants.sql',
      '1:specs/commission-examples.csv',
      '1:test/acceptance/old.test.ts',
      '1:test/spec/money/round.test.ts',
    ]);
  });

  it('treats a rename into a class-1 directory as an addition', () => {
    expect(
      hitsOf([{ path: 'test/spec/money/a.test.ts', status: 'R', oldPath: 'scratch/a.test.ts' }]),
    ).toEqual([]);
  });

  it('counts any change on class 2 and 3, including new files and both sides of a rename', () => {
    expect(
      hitsOf([
        { path: 'turbo.json', status: 'M' },
        { path: 'packages/money/vitest.config.ts', status: '?' },
        { path: 'tools/guard/new.ts', status: 'A' },
        { path: 'docs/x.md', status: 'R', oldPath: 'apps/api/AGENTS.md' },
        { path: '.github/workflows/ci.yml', status: 'D' },
        { path: 'ops/approvals.yaml', status: 'M' },
        { path: 'packages/money/src/index.ts', status: 'M' },
        { path: 'ops/tasks/B2-03.yaml', status: 'M' },
      ]),
    ).toEqual([
      '2:packages/money/vitest.config.ts',
      '2:turbo.json',
      '3:.github/workflows/ci.yml',
      '3:apps/api/AGENTS.md',
      '3:ops/approvals.yaml',
      '3:tools/guard/new.ts',
    ]);
  });

  it('reports a file under both classes when both apply', () => {
    expect(hitsOf([{ path: 'packages/testing/vitest.config.ts', status: 'M' }])).toEqual([
      '1:packages/testing/vitest.config.ts',
      '2:packages/testing/vitest.config.ts',
    ]);
  });

  it('matches protected names case-insensitively', () => {
    expect(hitsOf([{ path: 'packages/money/agents.md', status: '?' }])).toEqual([
      '3:packages/money/agents.md',
    ]);
  });

  it('flags package.json only when its scripts object changed', () => {
    const before = JSON.stringify({ name: 'x', scripts: { test: 'vitest run', build: 'tsc -b' } });
    const reordered = JSON.stringify({
      name: 'x',
      dependencies: { zod: '4.6.5' },
      scripts: { build: 'tsc -b', test: 'vitest run' },
    });
    const changed = JSON.stringify({ name: 'x', scripts: { test: 'true', build: 'tsc -b' } });
    const change: Change[] = [{ path: 'apps/api/package.json', status: 'M' }];
    const path = 'apps/api/package.json';
    expect(hitsOf(change, readers({ [path]: before }, { [path]: reordered }))).toEqual([]);
    expect(hitsOf(change, readers({ [path]: before }, { [path]: changed }))).toEqual([`2:${path}`]);
    expect(hitsOf(change, readers({ [path]: before }, { [path]: '{ not json' }))).toEqual([
      `2:${path}`,
    ]);
  });

  it('handles added and deleted package.json files', () => {
    const withScripts = JSON.stringify({ name: 'new', scripts: { test: 'vitest run' } });
    const withoutScripts = JSON.stringify({ name: 'new', scripts: {} });
    const path = 'packages/new/package.json';
    expect(hitsOf([{ path, status: '?' }], readers({}, { [path]: withScripts }))).toEqual([
      `2:${path}`,
    ]);
    expect(hitsOf([{ path, status: '?' }], readers({}, { [path]: withoutScripts }))).toEqual([]);
    expect(hitsOf([{ path, status: 'D' }], readers({ [path]: withScripts }, {}))).toEqual([
      `2:${path}`,
    ]);
    expect(hitsOf([{ path: 'package.json', status: 'M' }], readers({}, {}))).toEqual([]);
  });

  it('exempts the lock file only for deps tasks', () => {
    const changes: Change[] = [
      { path: 'pnpm-lock.yaml', status: 'M' },
      { path: 'pnpm-workspace.yaml', status: 'M' },
    ];
    expect(hitsOf(changes)).toEqual(['2:pnpm-lock.yaml', '2:pnpm-workspace.yaml']);
    expect(hitsOf(changes, NO_CONTENT, 'impl')).toEqual([
      '2:pnpm-lock.yaml',
      '2:pnpm-workspace.yaml',
    ]);
    expect(hitsOf(changes, NO_CONTENT, 'deps')).toEqual(['2:pnpm-workspace.yaml']);
  });

  it('describes the change and names the matching rule', () => {
    const [hit] = findProtectedHits([{ path: 'tools/guard/run.ts', status: 'D' }], cfg, NO_CONTENT);
    expect(hit).toEqual({
      path: 'tools/guard/run.ts',
      class: 3,
      rule: 'tools/**',
      change: 'deleted',
    });
  });
});

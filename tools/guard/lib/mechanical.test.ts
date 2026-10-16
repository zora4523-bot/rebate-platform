// Unit tests of the mechanical contract commit rules (ops/approvals.yaml id 31).
import { expect, it } from 'vitest';
import { mechanicalProblems, parseRangeLog, plannedRemovalProblem } from './mechanical.ts';

const BEFORE = [
  '  /v1/a:',
  '    get:',
  '      x-implementation: planned',
  '      responses: {}',
  '  /v1/b:',
  '    get:',
  "      x-implementation: 'planned'",
  '      responses: {}',
  '',
].join('\n');

it('accepts the contract with only planned lines removed, one or several', () => {
  expect(
    plannedRemovalProblem(BEFORE, BEFORE.replace('      x-implementation: planned\n', '')),
  ).toBe(null);
  const both = BEFORE.replace('      x-implementation: planned\n', '').replace(
    "      x-implementation: 'planned'\n",
    '',
  );
  expect(plannedRemovalProblem(BEFORE, both)).toBe(null);
});

it('refuses any other removal, edit or addition, and a change that removes nothing', () => {
  // One more line than planned.
  expect(
    plannedRemovalProblem(
      BEFORE,
      BEFORE.replace('      x-implementation: planned\n      responses: {}\n', ''),
    ),
  ).toContain('line 4');
  // The key changed instead of removed.
  expect(
    plannedRemovalProblem(
      BEFORE,
      BEFORE.replace('x-implementation: planned', 'x-implementation: done'),
    ),
  ).not.toBe(null);
  // A line added.
  expect(
    plannedRemovalProblem(
      BEFORE,
      BEFORE.replace('      x-implementation: planned\n', '      x-auth: none\n'),
    ),
  ).not.toBe(null);
  expect(plannedRemovalProblem(`${BEFORE}x`, `${BEFORE}x\nextra: 1`)).toContain('added');
  expect(plannedRemovalProblem(BEFORE, BEFORE)).toBe('no "x-implementation: planned" line removed');
  // Another key that merely mentions planned is not the marker.
  const other = 'a:\n  description: x-implementation: planned later\n';
  expect(plannedRemovalProblem(other, 'a:\n')).toContain('line 2');
});

const scope = {
  ledger: ['contracts/openapi.yaml', 'apps/api/src/**/route-schemas.gen.ts'],
  allowed: [
    'contracts/openapi.yaml',
    'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
  ],
  before: (path: string) => (path === 'contracts/openapi.yaml' ? BEFORE : 'x\n'),
  after: (path: string) =>
    path === 'contracts/openapi.yaml'
      ? BEFORE.replace('      x-implementation: planned\n', '')
      : 'y\n',
};

it('allows only files in both the ledger and the trusted list, modified only', () => {
  expect(
    mechanicalProblems(
      'c1',
      [
        { path: 'contracts/openapi.yaml', status: 'M' },
        { path: 'apps/api/src/modules/platform/validation/route-schemas.gen.ts', status: 'M' },
      ],
      scope,
    ),
  ).toEqual([]);
  const problems = mechanicalProblems(
    'c1',
    [
      // In the ledger glob, not in the trusted list.
      { path: 'apps/api/src/modules/other/route-schemas.gen.ts', status: 'M' },
      { path: 'apps/api/src/modules/content/a.ts', status: 'M' },
      { path: 'apps/api/src/modules/platform/validation/route-schemas.gen.ts', status: 'D' },
      {
        path: 'contracts/openapi.yaml',
        status: 'R',
        oldPath: 'contracts/old.yaml',
      },
    ],
    scope,
  );
  expect(problems).toEqual([
    'c1: apps/api/src/modules/other/route-schemas.gen.ts: outside the mechanical_paths (ledger and tools/guard/codex-impl-tasks.json) of a mechanical commit',
    'c1: apps/api/src/modules/content/a.ts: outside the mechanical_paths (ledger and tools/guard/codex-impl-tasks.json) of a mechanical commit',
    'c1: apps/api/src/modules/platform/validation/route-schemas.gen.ts: a mechanical commit may only modify files (status D)',
    'c1: contracts/openapi.yaml: renamed from contracts/old.yaml in a mechanical commit',
  ]);
});

it('fails closed without ledger or trusted mechanical_paths, and on an empty commit', () => {
  const change = [{ path: 'contracts/openapi.yaml', status: 'M' as const }];
  expect(mechanicalProblems('c1', change, { ...scope, ledger: [] })[0]).toContain(
    'the task ledger names no mechanical_paths',
  );
  expect(mechanicalProblems('c1', change, { ...scope, allowed: [] })[0]).toContain('fail-closed');
  expect(mechanicalProblems('c1', [], scope)).toEqual(['c1: a mechanical commit with no change']);
});

it('parses the range log with parents and trailer values', () => {
  const out = 'aaa\x1fp1\x1fcontract-codegen\0\nbbb\x1fp2 p3\x1f\0\nccc\x1f\x1fx\x1ey\0';
  expect(parseRangeLog(out)).toEqual([
    { sha: 'aaa', parents: ['p1'], mechanical: ['contract-codegen'] },
    { sha: 'bbb', parents: ['p2', 'p3'], mechanical: [] },
    { sha: 'ccc', parents: [], mechanical: ['x', 'y'] },
  ]);
});

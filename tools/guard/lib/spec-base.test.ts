// Unit tests of the rule-test author's path rules (规划/11 §2.3 step 3; owner decision 2026-10-02).
import { expect, it } from 'vitest';
import { authorProblems, checkAuthorPaths, evidencePath } from './spec-base.ts';

const scope = (contents: Record<string, string>) => ({
  taskPaths: ['packages/money/src/**'],
  testAssets: ['test/spec/**', 'test/properties/**', 'packages/testing/**'],
  contentAtSpec: (path: string) => contents[path] ?? null,
});

it('allows rule-test assets, the ledger and NotImplemented skeleton shells', () => {
  expect(
    authorProblems(
      [
        { path: 'test/spec/money/a.test.ts', status: 'A' },
        { path: 'test/properties/money/arb.ts', status: 'A' },
        { path: 'ops/tasks/B2-01a.yaml', status: 'M' },
        { path: 'packages/money/src/index.ts', status: 'M' },
      ],
      scope({
        'packages/money/src/index.ts':
          "export function f(): never {\n  throw new Error('NotImplemented: f');\n}\n",
      }),
    ),
  ).toEqual([]);
  expect(evidencePath('B2-01a')).toBe('ops/evidence/B2-01a.json');
});

it('rejects implementation, removals, renames out of the task paths and other paths', () => {
  const problems = authorProblems(
    [
      { path: 'packages/money/src/impl.ts', status: 'A' },
      { path: 'packages/money/src/old.ts', status: 'D' },
      { path: 'packages/money/src/new.ts', status: 'R', oldPath: 'packages/money/src/moved.ts' },
      { path: 'packages/domain/src/clock.ts', status: 'M' },
      { path: 'ops/approvals.yaml', status: 'M' },
    ],
    scope({
      'packages/money/src/impl.ts': 'export const f = () => 1;\n',
      'packages/money/src/new.ts': '// NotImplemented skeleton\n',
    }),
  );
  expect(problems.map((p) => p.split(':')[0])).toEqual([
    'packages/money/src/impl.ts',
    'packages/money/src/old.ts',
    'packages/money/src/moved.ts',
    'packages/domain/src/clock.ts',
    'ops/approvals.yaml',
  ]);
  expect(problems[0]).toContain('not a NotImplemented skeleton shell');
  expect(problems[1]).toContain('removed in a rule-test commit');
  expect(problems[2]).toContain('removed in a rule-test commit');
  expect(problems[3]).toContain("outside the rule-test author's paths");
});

it('[CR3-02] a legacy ledger keeps the old skeleton rule; any other task gets the new one', () => {
  // B1-01s shape: the frozen skeleton adds constants next to NotImplemented functions.
  const skeleton = [
    "export const DAY_PARTITIONED_TABLES: readonly string[] = Object.freeze(['link_logs']);",
    'const DAYS_AHEAD = 14;',
    'export function ensure(days: number = DAYS_AHEAD): never {',
    '  void days;',
    "  throw new Error('NotImplemented: ensure');",
    '}',
    '',
  ].join('\n');
  const changes = [{ path: 'packages/money/src/index.ts', status: 'M' as const }];
  const files = { 'packages/money/src/index.ts': skeleton };
  expect(authorProblems(changes, { ...scope(files), legacySkeleton: true })).toEqual([]);
  const strict = authorProblems(changes, scope(files)).join('\n');
  expect(strict).toContain('executable top-level code is not a skeleton');
  // The old rule still needs the keyword.
  expect(
    authorProblems(changes, {
      ...scope({ 'packages/money/src/index.ts': 'export const a = 1;\n' }),
      legacySkeleton: true,
    }).join('\n'),
  ).toContain('does not name NotImplemented');
});

it('[ops/approvals.yaml id 19] the working tree of a Codex rule-test run: tests and skeletons only', () => {
  const result = checkAuthorPaths(
    [
      { path: 'test/spec/money/a.test.ts', status: '?' },
      { path: 'packages/money/src/index.ts', status: 'M' },
      { path: 'packages/money/src/impl.ts', status: '?' },
      { path: 'packages/money/src/gone.ts', status: 'D' },
      { path: 'docs/notes.md', status: '?' },
      { path: 'ops/tasks/B2-01a.yaml', status: 'M' },
      { path: 'apps/api/src/x.ts', status: 'M' },
    ],
    scope({
      'packages/money/src/index.ts':
        "export function f(): never { throw new NotImplemented('f'); }\n",
      'packages/money/src/impl.ts': 'export const f = (a: number) => a + 1;\n',
    }),
    [{ path: 'test/spec/money/a.test.ts', class: 1, rule: 'test/spec/**', change: 'added' }],
  );
  expect(result.ok).toBe(false);
  expect(result.violations.map((v) => v.path)).toEqual([
    'packages/money/src/impl.ts',
    'packages/money/src/gone.ts',
    'apps/api/src/x.ts',
  ]);
  expect(result.violations[0]?.reason).toContain('implementation in a rule-test run');
  // ops/ and docs/ (the ledger included: it is the orchestrator's) are reverted, not a failure.
  expect(result.out_of_scope_ops_docs).toEqual(['docs/notes.md', 'ops/tasks/B2-01a.yaml']);
  expect(result.protected_hits).toEqual([{ path: 'test/spec/money/a.test.ts', class: 1 }]);
  expect(
    checkAuthorPaths([{ path: 'test/properties/money/arb.ts', status: '?' }], scope({}), []).ok,
  ).toBe(true);
});

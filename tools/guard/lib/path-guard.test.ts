import { describe, expect, it } from 'vitest';
import type { Change } from '../../lib/git.ts';
import { checkPaths } from './path-guard.ts';

const allowed = ['apps/api/src/modules/ledger/**', 'packages/money/src/*.ts'];

describe('checkPaths', () => {
  it('passes when every change is inside the task paths', () => {
    const changes: Change[] = [
      { path: 'apps/api/src/modules/ledger/post.ts', status: 'M' },
      { path: 'apps/api/src/modules/ledger/新 文件.ts', status: '?' },
      { path: 'packages/money/src/round.ts', status: 'A' },
    ];
    expect(checkPaths(changes, allowed, [])).toEqual({
      ok: true,
      violations: [],
      out_of_scope_ops_docs: [],
      protected_hits: [],
    });
  });

  it('reports every out-of-scope change, including untracked files and deletions', () => {
    const changes: Change[] = [
      { path: 'apps/api/src/modules/orders/sync.ts', status: 'M' },
      { path: 'packages/money/src/deep/x.ts', status: '?' },
      { path: 'turbo.json', status: 'D' },
    ];
    const res = checkPaths(changes, allowed, []);
    expect(res.ok).toBe(false);
    expect(res.violations).toEqual([
      { path: 'apps/api/src/modules/orders/sync.ts', reason: 'modified outside the task paths' },
      { path: 'packages/money/src/deep/x.ts', reason: 'untracked file outside the task paths' },
      { path: 'turbo.json', reason: 'deleted outside the task paths' },
    ]);
  });

  it('checks both sides of a rename', () => {
    const res = checkPaths(
      [
        {
          path: 'apps/api/src/modules/ledger/moved.ts',
          status: 'R',
          oldPath: 'apps/api/src/modules/orders/moved.ts',
        },
      ],
      allowed,
      [],
    );
    expect(res.violations).toEqual([
      {
        path: 'apps/api/src/modules/orders/moved.ts',
        reason: 'renamed away outside the task paths',
      },
    ]);
  });

  it('lists out-of-scope ops/ and docs/ changes without failing', () => {
    const res = checkPaths(
      [
        { path: 'ops/tasks/B2-02a.yaml', status: 'M' },
        { path: 'docs/notes.md', status: '?' },
        { path: 'apps/api/src/modules/ledger/post.ts', status: 'M' },
      ],
      allowed,
      [],
    );
    expect(res.ok).toBe(true);
    expect(res.out_of_scope_ops_docs).toEqual(['docs/notes.md', 'ops/tasks/B2-02a.yaml']);
  });

  it('keeps ops/ and docs/ changes in scope when the task lists them', () => {
    const res = checkPaths([{ path: 'docs/glossary.md', status: 'M' }], ['docs/**'], []);
    expect(res).toMatchObject({ ok: true, out_of_scope_ops_docs: [] });
  });

  it('passes protected hits through', () => {
    const res = checkPaths([{ path: 'ops/risk-map.yaml', status: 'M' }], allowed, [
      { path: 'ops/risk-map.yaml', class: 3, rule: 'ops/risk-map.yaml', change: 'modified' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.protected_hits).toEqual([{ path: 'ops/risk-map.yaml', class: 3 }]);
  });
});

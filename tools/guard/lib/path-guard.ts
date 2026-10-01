// Path guard (规划/11 §2.3 step 6): every change must stay inside the task's `paths`.
import type { Change } from '../../lib/git.ts';
import { matchesAny } from '../../lib/glob.ts';
import type { ProtectedClass, ProtectedHit } from './protected.ts';

export type PathGuardResult = {
  ok: boolean;
  violations: { path: string; reason: string }[];
  out_of_scope_ops_docs: string[];
  protected_hits: { path: string; class: ProtectedClass }[];
};

/**
 * - A change (both sides of a rename) outside `allowed` is a violation.
 * - Out-of-scope changes under `ops/` or `docs/` are listed separately and do not fail the
 *   guard: the orchestrator reverts and records them (规划/11 §2.3 step 6).
 * - Protected hits are reported for the caller; protected-paths.ts is the gate for them.
 */
export function checkPaths(
  changes: readonly Change[],
  allowed: readonly string[],
  protectedHits: readonly ProtectedHit[],
): PathGuardResult {
  const violations: { path: string; reason: string }[] = [];
  const opsDocs = new Set<string>();
  const seen = new Set<string>();
  for (const change of changes) {
    const sides: [string, string][] = [[change.path, statusText(change.status)]];
    if (change.oldPath !== undefined) sides.push([change.oldPath, 'renamed away']);
    for (const [path, what] of sides) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (matchesAny(path, allowed)) continue;
      if (path.startsWith('ops/') || path.startsWith('docs/')) {
        opsDocs.add(path);
      } else {
        violations.push({ path, reason: `${what} outside the task paths` });
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    out_of_scope_ops_docs: [...opsDocs].sort(),
    protected_hits: protectedHits.map((h) => ({ path: h.path, class: h.class })),
  };
}

function statusText(status: Change['status']): string {
  switch (status) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case '?':
      return 'untracked file';
  }
}

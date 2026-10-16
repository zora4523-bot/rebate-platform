// Mechanical contract commits of a Codex implementation (ops/approvals.yaml id 31; 规划/11 §7.3
// row 11, carrying out id 30). An interface task must remove `x-implementation: planned` from
// contracts/openapi.yaml and regenerate the files derived from it in the same pull request
// (apps/api/src/contract.test.ts), but Codex may not touch the contract or the generated
// clients (tools/guard/codex-impl-tasks.json forbidden_paths). So the orchestrator (Claude) does
// that part in commits of its own, marked with the trailer `Couli-Mechanical: contract-codegen`,
// and guard-git holds them to rules of their own:
// - only the ledger's `mechanical_paths` that are also in the trusted list's `mechanical_paths`;
// - no addition, deletion or rename; a generated file (`*.gen.ts`) may only be modified;
// - any other file (the contract) may only lose lines `x-implementation: planned`;
// - that the generated files equal a fresh `pnpm contracts:codegen` is left to the required
//   checks contracts-gate (codegen --check) and ci-gate (contract-routes.test.ts).
// Every commit without the trailer is held to the ledger `paths`, as before. The trailer gives a
// commit no reach beyond those files, so it cannot widen what a Codex commit may change.
import type { Change } from '../../lib/git.ts';
import { matchesAny } from '../../lib/glob.ts';

export const MECHANICAL_TRAILER = 'Couli-Mechanical';
export const MECHANICAL_VALUE = 'contract-codegen';

/** The one line a mechanical commit may remove from the contract (any indentation, optional quotes). */
const PLANNED_LINE = /^[ \t]*x-implementation:[ \t]*(?:planned|'planned'|"planned")[ \t]*$/;

/** True when `path` is a file generated from the contract (checked for drift by CI). */
export function isGeneratedFile(path: string): boolean {
  return path.endsWith('.gen.ts');
}

/**
 * Null when `after` is `before` with only `x-implementation: planned` lines removed (at least
 * one); otherwise the reason. Greedy matching is exact here: a skipped line is always a planned
 * line, so matching an equal planned line first never loses a solution.
 */
export function plannedRemovalProblem(before: string, after: string): string | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let j = 0;
  let removed = 0;
  for (let i = 0; i < a.length; i++) {
    const line = a[i] ?? '';
    if (j < b.length && line === b[j]) {
      j++;
    } else if (PLANNED_LINE.test(line)) {
      removed++;
    } else {
      return `line ${i + 1} ("${line.trim().slice(0, 60)}") changed or removed; only "x-implementation: planned" lines may be removed`;
    }
  }
  if (j < b.length) {
    return `line ${j + 1} ("${(b[j] ?? '').trim().slice(0, 60)}") added; only "x-implementation: planned" lines may be removed`;
  }
  if (removed === 0) return 'no "x-implementation: planned" line removed';
  return null;
}

export type MechanicalScope = {
  /** The ledger's `mechanical_paths`. */
  ledger: readonly string[];
  /** `mechanical_paths` of tools/guard/codex-impl-tasks.json in the trusted root. */
  allowed: readonly string[];
  /** Content of `path` before and after the commit (null: absent). */
  before: (path: string) => string | null;
  after: (path: string) => string | null;
};

/** Problems of one mechanical commit; `label` names the commit in each line. */
export function mechanicalProblems(
  label: string,
  changes: readonly Change[],
  scope: MechanicalScope,
): string[] {
  const problems: string[] = [];
  if (scope.ledger.length === 0) {
    return [
      `${label}: marked ${MECHANICAL_TRAILER}: ${MECHANICAL_VALUE}, but the task ledger names no mechanical_paths`,
    ];
  }
  if (scope.allowed.length === 0) {
    return [
      `${label}: marked ${MECHANICAL_TRAILER}, but the trusted tools/guard/codex-impl-tasks.json has no mechanical_paths (fail-closed)`,
    ];
  }
  if (changes.length === 0) problems.push(`${label}: a mechanical commit with no change`);
  for (const change of changes) {
    const where = `${label}: ${change.path}`;
    if (change.oldPath !== undefined) {
      problems.push(`${where}: renamed from ${change.oldPath} in a mechanical commit`);
      continue;
    }
    if (!matchesAny(change.path, scope.ledger) || !matchesAny(change.path, scope.allowed)) {
      problems.push(
        `${where}: outside the mechanical_paths (ledger and tools/guard/codex-impl-tasks.json) of a mechanical commit`,
      );
      continue;
    }
    if (change.status !== 'M') {
      problems.push(
        `${where}: a mechanical commit may only modify files (status ${change.status})`,
      );
      continue;
    }
    if (isGeneratedFile(change.path)) continue;
    const before = scope.before(change.path);
    const after = scope.after(change.path);
    const problem =
      before === null || after === null
        ? 'cannot be read on both sides of the commit'
        : plannedRemovalProblem(before, after);
    if (problem !== null) problems.push(`${where}: ${problem}`);
  }
  return problems;
}

/** Parses `git log -z --format=%H%x1f%P%x1f%(trailers:key=…,valueonly,separator=%x1e)` output. */
export function parseRangeLog(
  out: string,
): { sha: string; parents: string[]; mechanical: string[] }[] {
  return out
    .split('\0')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha = '', parents = '', trailers = ''] = record.split('\x1f');
      return {
        sha: sha.trim(),
        parents: parents.trim() === '' ? [] : parents.trim().split(' '),
        mechanical: trailers
          .split('\x1e')
          .map((v) => v.trim())
          .filter((v) => v !== ''),
      };
    });
}

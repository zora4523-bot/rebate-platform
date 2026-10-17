// Tasks moved to a Codex implementation with Claude rule tests (owner 2026-10-06,
// ops/approvals.yaml id 23; 规划/11 §1.1 例外, §7.3 row 14), and since 2026-10-16 every task not
// yet started (owner, ops/approvals.yaml id 30; 规划/11 §1.1, §7.3 row 15), listed one by one
// under the id of its ledger. Since 2026-10-17 (owner, ops/approvals.yaml id 34; 规划/11 §1.1, §7.3
// row 16) implementation is back with Claude and the list is frozen: id 30 is superseded, nothing
// is added, the listed tasks already started finish as Codex implementations (ids 31, 33) and the
// rest go back to impl: claude at their next ledger PR; the frozen set lives in the test file.
// The list is tools/guard/codex-impl-tasks.json, read from the trusted
// root by the gates. The exception is granted per split task, not per 规划/05 row: an entry with a
// lowercase suffix (B1-14a) lists that one task; an entry without (B3-02) is a row the exception
// covers whole, with all its split tasks. A missing or broken file lists nothing (fail-closed:
// every new ledger then keeps the default split of 2026-10-05).
// `mechanical_paths` of the file (ops/approvals.yaml id 31) are the only paths a listed ledger may
// name in its own `mechanical_paths`: the contract file whose `x-implementation: planned` markers
// a Claude commit removes, and the files generated from it. Codex never writes them; guard-git
// checks the commits marked `Couli-Mechanical: contract-codegen` against them
// (tools/guard/lib/mechanical.ts). A missing or broken file allows none.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskFile } from './task-file.ts';

export const CODEX_IMPL_TASKS_FILE = 'tools/guard/codex-impl-tasks.json';

const ENTRY = /^[A-Z][A-Z0-9]*-[0-9]{2}[a-z]*$/;
const ROW = /^[A-Z][A-Z0-9]*-[0-9]{2}$/;

/** The listed entries; anything not of the shape `X1-01` or `X1-01a` is dropped. */
export function loadCodexImplTasks(root: string): string[] {
  const file = join(root, CODEX_IMPL_TASKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown };
    return Array.isArray(doc.tasks)
      ? doc.tasks.filter((p): p is string => typeof p === 'string' && ENTRY.test(p))
      : [];
  } catch {
    return [];
  }
}

/** Path globs a Codex-first ledger must not reach (`forbidden_paths`); a broken file gives none. */
export function loadCodexImplForbidden(root: string): string[] {
  const file = join(root, CODEX_IMPL_TASKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { forbidden_paths?: unknown };
    return Array.isArray(doc.forbidden_paths)
      ? doc.forbidden_paths.filter((p): p is string => typeof p === 'string' && p !== '')
      : [];
  } catch {
    return [];
  }
}

/** Path globs a listed ledger may name in `mechanical_paths`; a broken file gives none (id 31). */
export function loadCodexImplMechanical(root: string): string[] {
  const file = join(root, CODEX_IMPL_TASKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { mechanical_paths?: unknown };
    return Array.isArray(doc.mechanical_paths)
      ? doc.mechanical_paths.filter((p): p is string => typeof p === 'string' && p !== '')
      : [];
  } catch {
    return [];
  }
}

/** True when `id` is listed itself, or is a split task of a row listed whole. */
export function isCodexImplTask(id: string, entries: readonly string[]): boolean {
  if (!ENTRY.test(id)) return false;
  const row = id.replace(/[a-z]+$/, '');
  return entries.some((e) => e === id || (ROW.test(e) && e === row));
}

/**
 * The Codex-first split of a listed task: Codex implements, Claude wrote the rule tests. Only
 * that pair is let through; any other pair of a listed task follows the default split.
 */
export function isCodexFirst(
  task: Pick<TaskFile, 'id' | 'impl' | 'tester'>,
  entries: readonly string[],
): boolean {
  return task.impl === 'codex' && task.tester === 'claude' && isCodexImplTask(task.id, entries);
}

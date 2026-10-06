// Tasks moved to a Codex implementation with Claude rule tests (owner 2026-10-06,
// ops/approvals.yaml id 23; 规划/11 §1.1 例外, §7.3 row 14). The list is
// tools/guard/codex-impl-tasks.json, read from the trusted root by the gates. The exception is
// granted per split task, not per 规划/05 row: an entry with a lowercase suffix (B1-14a) lists that
// one task; an entry without (B3-02) is a row the exception covers whole, with all its split
// tasks. A missing or broken file lists nothing (fail-closed: every new ledger then keeps the
// default split of 2026-10-05).
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

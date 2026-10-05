// Task ledgers written before the default split of 2026-10-05 (Codex review CR2-02): the fixed
// list in tools/guard/legacy-tasks.json (ops/tasks at the switch baseline dec8a3d). Only these may
// omit `test_paths`; read from the trusted root by the guards. A missing or broken file means an
// empty list (fail-closed: every task with a rule-test author then needs test_paths).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskFile } from './task-file.ts';

export const LEGACY_TASKS_FILE = 'tools/guard/legacy-tasks.json';

export function loadLegacyTasks(root: string): Set<string> {
  const file = join(root, LEGACY_TASKS_FILE);
  if (!existsSync(file)) return new Set();
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown };
    return Array.isArray(doc.tasks)
      ? new Set(doc.tasks.filter((t): t is string => typeof t === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

/** A task with a rule-test author that is not on the legacy list must name its test_paths. */
export function needsTestPaths(
  task: Pick<TaskFile, 'id' | 'tester'>,
  legacy: Set<string>,
): boolean {
  return task.tester !== 'none' && !legacy.has(task.id);
}

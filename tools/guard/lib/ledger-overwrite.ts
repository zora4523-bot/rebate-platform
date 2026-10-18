// Ledger overwrite guard (CT-06q, 2026-10-18). A pull request may add task files to
// ops/tasks/ and move the ones it finds there forward, but it may not turn one of them into
// another task: chore(ops) #778 overwrote ops/tasks/F1-09i.yaml, the done test-change task of
// #717, with a new impl task of the same id, and nothing refused it (the directory is RV0 and
// not a protected path). Rules, for every `ops/tasks/<id>.yaml` that exists at the fork point
// of the pull request (the merge base of --base and HEAD, so a branch behind the base is not
// blamed for what the base changed meanwhile):
// - `id`, `type` and `title` may not change (a change of scope is a new task with a new id);
// - `status: done` may not go back to anything else;
// - the file may not be deleted or renamed (ops/tasks never lost a file; fail-closed).
// Everything else is free: status forward, `pr`, `paths`, `test_paths`, `refs`, `refs_hash`,
// `deps`, `accept`, `mechanical_paths`, and the comment lines. A side that cannot be parsed
// fails (the comparison cannot be made; task.ts check keeps the base parseable).
// No owner label waives these problems: guard-git lists them next to the path guard.
import type { Change } from '../../lib/git.ts';
import { parseTaskFile } from '../../lib/task-file.ts';
import type { TaskFile } from '../../lib/task-file.ts';

/** A task file directly under ops/tasks (the `archive/` tree, if ever used, is not a ledger). */
export const LEDGER_FILE = /^ops\/tasks\/([^/]+)\.ya?ml$/;

/** The fields a pull request may not change on a task file that already exists. */
export const FROZEN_FIELDS = ['id', 'type', 'title'] as const;

export type LedgerSides = {
  /** Content of `path` at the fork point (null: absent there). */
  before: (path: string) => string | null;
  /** Content of `path` in the inspected tree (null: absent). */
  after: (path: string) => string | null;
};

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parse(text: string, path: string): { task: TaskFile } | { error: string } {
  try {
    return { task: parseTaskFile(text, path) };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '' };
  }
}

/**
 * The problems of one existing task file changed from `before` to `after` (both parseable
 * texts), or none. Exported for the unit tests; `ledgerOverwriteProblems` is the entry point.
 */
export function compareLedger(path: string, before: TaskFile, after: TaskFile): string[] {
  const details: string[] = [];
  for (const field of FROZEN_FIELDS) {
    if (before[field] !== after[field]) {
      details.push(`${field} 「${clip(before[field])}」→「${clip(after[field])}」`);
    }
  }
  const reverted = before.status === 'done' && after.status !== 'done';
  if (reverted) details.push(`status done → ${after.status}`);
  if (details.length === 0) return [];
  const what = details.join('；');
  if (before.status === 'done') {
    return [`${path}: ${before.id} 已存在且为 done，新任务请换编号（${what}）`];
  }
  return [
    `${path}: ${before.id} 已存在（status ${before.status}），不得改 ${FROZEN_FIELDS.join(' / ')}；` +
      `改范围请换编号，补充字段请保留这三项（${what}）`,
  ];
}

/**
 * Problems of the ledger files among `changes` (a diff of the inspected tree against the fork
 * point, as `changedFiles` reports it, renames as `R` with `oldPath`).
 */
export function ledgerOverwriteProblems(changes: readonly Change[], sides: LedgerSides): string[] {
  const problems: string[] = [];
  for (const change of changes) {
    if (change.status === 'R' && change.oldPath !== undefined && LEDGER_FILE.test(change.oldPath)) {
      const id = LEDGER_FILE.exec(change.oldPath)?.[1] ?? change.oldPath;
      problems.push(
        `${change.oldPath}: ${id} 已存在，台账文件不得改名或移动（改成了 ${change.path}）；新任务请换编号新增文件`,
      );
      continue;
    }
    const match = LEDGER_FILE.exec(change.path);
    if (match === null) continue;
    const id = match[1] ?? change.path;
    if (change.status === 'D') {
      problems.push(
        `${change.path}: ${id} 已存在，台账文件不得删除；作废请保留文件、改 status 或加注释`,
      );
      continue;
    }
    if (change.status !== 'M') continue;
    const beforeText = sides.before(change.path);
    const afterText = sides.after(change.path);
    if (beforeText === null) continue; // not on the fork point: an added file, nothing to compare
    if (afterText === null) {
      problems.push(
        `${change.path}: ${id} 已存在，台账文件不得删除；作废请保留文件、改 status 或加注释`,
      );
      continue;
    }
    const before = parse(beforeText, change.path);
    if ('error' in before) {
      problems.push(`${change.path}: 基线上的台账无法解析，不能比对（${before.error}）`);
      continue;
    }
    const after = parse(afterText, change.path);
    if ('error' in after) {
      problems.push(`${change.path}: 改后的台账无法解析（${after.error}）`);
      continue;
    }
    problems.push(...compareLedger(change.path, before.task, after.task));
  }
  return problems;
}

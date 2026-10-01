// Small helpers shared by the tools/ops command line entry points.
// Exit codes (conventions C9): 0 ok, 1 check failed, 2 usage or internal error.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { trustedRoot } from '../lib/paths.ts';

export class UsageError extends Error {}

/** A check that failed in an expected way (exit code 1). */
export class CheckError extends Error {}

export type GuardResult = { status: number; stdout: string; stderr: string };

/**
 * Runs a guard from the trusted root as a child process (规划/11 §2.4: gates are
 * never loaded from the task worktree and never imported).
 */
export function runGuard(
  name: string,
  args: readonly string[],
  opts: { cwd?: string; input?: string } = {},
): GuardResult {
  const script = join(trustedRoot(), 'tools', 'guard', name);
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? trustedRoot(),
    encoding: 'utf8',
    input: opts.input ?? '',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new Error(`cannot run guard ${name}: ${res.error.message}`);
  return { status: res.status ?? 2, stdout: res.stdout, stderr: res.stderr };
}

/** Runs a CLI main function and maps errors to the exit code convention. */
export function runMain(main: (argv: string[]) => number): void {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof CheckError) {
      console.error(msg);
      process.exitCode = 1;
    } else if (err instanceof UsageError) {
      console.error(`usage error: ${msg}`);
      process.exitCode = 2;
    } else {
      console.error(`internal error: ${msg}`);
      process.exitCode = 2;
    }
  }
}

/** Same shape as TASK_ID_PATTERN in tools/lib/task-file.ts. */
export const TASK_ID = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$/;

/** Task ids are used as file and directory names: keep them boring. */
export function assertTaskId(id: string | undefined): string {
  if (id === undefined || !TASK_ID.test(id)) {
    throw new UsageError(`invalid task id: ${String(id)}`);
  }
  return id;
}

/** `2026-10-01 23:59` in +08:00, the owner's time zone. */
export function formatBeijing(d: Date): string {
  const shifted = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`;
}

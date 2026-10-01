// Shared command-line plumbing for the guards.
// Exit codes (conventions C9): 0 ok, 1 check failed / violation, 2 usage or internal error.
// `--json` prints one JSON document on stdout; human-readable text goes to stderr.
import { resolve } from 'node:path';
import { tryGit } from '../../lib/git.ts';

export class UsageError extends Error {}

export type Args = { values: Map<string, string>; flags: Set<string>; rest: string[] };

/** Parses `--name value`, `--name=value`, boolean `--flag`, and positional arguments. */
export function parseArgs(
  argv: readonly string[],
  spec: { values?: readonly string[]; flags?: readonly string[] },
): Args {
  const valueNames = new Set(spec.values ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const args: Args = { values: new Map(), flags: new Set(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      args.rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      args.rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (flagNames.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      args.flags.add(name);
    } else if (valueNames.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      args.values.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return args;
}

/**
 * The tree a guard inspects: `--cwd` verbatim when given, otherwise the git top level of the
 * current directory (or the current directory itself outside a work tree, e.g. in the verify
 * container, which has no `.git`).
 */
export function resolveRoot(cwdFlag: string | undefined): string {
  if (cwdFlag !== undefined) return resolve(cwdFlag);
  const here = process.cwd();
  try {
    const top = tryGit(['rev-parse', '--show-toplevel'], { cwd: here });
    return top.status === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : here;
  } catch {
    // No git binary at all (the verify image has none).
    return here;
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Runs a CLI entry point and maps its result and errors to the exit-code convention. */
export function runCli(usage: string, main: (argv: string[]) => number): void {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof UsageError) {
      console.error(`usage error: ${message}\nusage: ${usage}`);
    } else {
      console.error(`internal error: ${message}`);
    }
    process.exitCode = 2;
  }
}

export type CheckResult = {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  problems: string[];
  notices: string[];
};

export function result(name: string, problems: string[], notices: string[] = []): CheckResult {
  return { name, status: problems.length === 0 ? 'pass' : 'fail', problems, notices };
}

export function skipped(name: string, notice: string): CheckResult {
  return { name, status: 'skip', problems: [], notices: [notice] };
}

/** Prints notices and problems to stderr, one summary line to stdout; returns the exit code. */
export function report(check: CheckResult): number {
  for (const notice of check.notices) console.error(`${check.name}: notice: ${notice}`);
  for (const problem of check.problems) console.error(`${check.name}: ${problem}`);
  const label = check.status === 'pass' ? 'PASS' : check.status === 'skip' ? 'SKIP' : 'FAIL';
  const detail =
    check.status === 'fail'
      ? ` (${check.problems.length} problem${check.problems.length === 1 ? '' : 's'})`
      : check.status === 'skip'
        ? ` (${check.notices[0] ?? 'skipped'})`
        : '';
  process.stdout.write(`${label} ${check.name}${detail}\n`);
  return check.status === 'fail' ? 1 : 0;
}

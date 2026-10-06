// Command line of @couli/evals (B3-01b). Runs on Node's type stripping, no build step:
//
//   node packages/evals/src/cli.ts smoke-gate --cases <dir> --manifest <file> --report <file>
//     Reads every *.jsonl in <dir>. Load problems (io for an entry that cannot be read, such as
//     a directory, a broken link or a file without permission; json, schema, duplicate_id, also
//     across files): exit 2, prints only code, file basename and line, never a stack or an
//     absolute path. Otherwise runs checkSmokeGate, prints the SmokeVerdict as one JSON line on
//     stdout and exits 0 (passed) or 1; on failure stderr gets each problem's code and case id,
//     never case text or problem messages (BR-AI-21: a local replay writes back pass or fail
//     only). An unexpected exception is exit 2 with the code `internal` only.
//
//   node packages/evals/src/cli.ts identity-fields [--file <path>]
//     Checks specs/agent-identity-fields.txt (default: found from this file) against the
//     package's IDENTITY_FIELDS; exit 0 when equal, 1 on drift, 2 when it cannot be read.
//
// smoke-gate also runs the identity-field check when the specs file is present next to the
// package (in the repository), so the grader's list cannot drift from BR-AI-03 unnoticed. Only
// ENOENT skips it; an entry there that cannot be read, or a path that cannot be inspected
// (EACCES…), is an `io` load problem (exit 2).
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDuplicateIds, checkIdentityFieldsFile, checkSmokeGate, parseJsonl } from './index.ts';
import type { EvalCase, Manifest, Problem, Report } from './index.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

const USAGE =
  'usage: cli.ts smoke-gate --cases <dir> --manifest <file> --report <file>\n' +
  '       cli.ts identity-fields [--file <path>]\n';

const DEFAULT_IDENTITY_FILE = fileURLToPath(
  new URL('../../../specs/agent-identity-fields.txt', import.meta.url),
);

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !allowed.includes(flag) || value === undefined) return null;
    if (flags.has(flag)) return null;
    flags.set(flag, value);
  }
  return flags;
}

/** Load problems: code, file and line only (no message, no id: both can carry case text). */
function printLoadProblems(io: CliIo, problems: readonly Problem[]): void {
  for (const problem of problems) {
    io.err(`${problem.code} ${problem.file ?? '-'}:${problem.line ?? '-'}\n`);
  }
}

/** The identity-field check run by smoke-gate. Skipped only when nothing is at `path` (ENOENT:
 * outside the repository); any entry there, a broken link included, is read and checked. A
 * failure to even look (EACCES on a parent directory, …) is an `io` problem naming the basename,
 * never a silently skipped check. */
function smokeIdentityProblems(path: string): Problem[] {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return [];
    return [{ code: 'io', file: basename(path), message: 'cannot read file' }];
  }
  return identityProblems(path);
}

/** Reads a text file; a failure (directory, broken link, no permission…) is an `io` problem
 * that names only the basename, so no stack or private absolute path reaches the output. */
function readText(path: string): { text: string } | { problem: Problem } {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch {
    return { problem: { code: 'io', file: basename(path), message: 'cannot read file' } };
  }
}

function identityProblems(file: string): Problem[] {
  const read = readText(file);
  if ('problem' in read) return [read.problem];
  return checkIdentityFieldsFile(read.text).map((problem) => ({
    ...problem,
    file: basename(file),
  }));
}

function readJson(path: string): { value: unknown } | { problem: Problem } {
  const read = readText(path);
  if ('problem' in read) return read;
  try {
    return { value: JSON.parse(read.text) as unknown };
  } catch {
    return { problem: { code: 'json', file: basename(path), message: 'unreadable JSON' } };
  }
}

function smokeGate(args: string[], io: CliIo): number {
  const flags = parseFlags(args, ['--cases', '--manifest', '--report']);
  const casesDir = flags?.get('--cases');
  const manifestPath = flags?.get('--manifest');
  const reportPath = flags?.get('--report');
  if (casesDir === undefined || manifestPath === undefined || reportPath === undefined) {
    io.err(USAGE);
    return 2;
  }

  const loadProblems: Problem[] = [...smokeIdentityProblems(DEFAULT_IDENTITY_FILE)];

  const cases: EvalCase[] = [];
  const files: string[] = [];
  let names: string[];
  try {
    names = readdirSync(casesDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    io.err(`io ${basename(casesDir)}:-\n`);
    return 2;
  }
  for (const name of names) {
    const read = readText(join(casesDir, name));
    if ('problem' in read) {
      loadProblems.push(read.problem);
      continue;
    }
    const parsed = parseJsonl(read.text, name);
    loadProblems.push(...parsed.problems);
    for (const item of parsed.cases) {
      cases.push(item);
      files.push(name);
    }
  }
  loadProblems.push(...checkDuplicateIds(cases, files));

  const manifest = readJson(manifestPath);
  const report = readJson(reportPath);
  if ('problem' in manifest) loadProblems.push(manifest.problem);
  if ('problem' in report) loadProblems.push(report.problem);
  if (loadProblems.length > 0 || 'problem' in manifest || 'problem' in report) {
    printLoadProblems(io, loadProblems);
    return 2;
  }

  const gate = checkSmokeGate(report.value as Report, manifest.value as Manifest, cases);
  io.out(`${JSON.stringify(gate.verdict)}\n`);
  if (gate.passed) return 0;
  for (const problem of gate.problems) {
    io.err(problem.id === undefined ? `${problem.code}\n` : `${problem.code} ${problem.id}\n`);
  }
  return 1;
}

function identityFields(args: string[], io: CliIo): number {
  const flags = parseFlags(args, ['--file']);
  if (flags === null) {
    io.err(USAGE);
    return 2;
  }
  const file = flags.get('--file') ?? DEFAULT_IDENTITY_FILE;
  const problems = identityProblems(file);
  if (problems.some((problem) => problem.code === 'io')) {
    printLoadProblems(io, problems);
    return 2;
  }
  for (const problem of problems) io.err(`${problem.code}: ${problem.message}\n`);
  return problems.length === 0 ? 0 : 1;
}

// B3-01c test phase: command handlers are shells; main dispatch is wired by the implementer.
export function releaseGate(args: string[], io: CliIo): number {
  void args;
  void io;
  throw new Error('NotImplemented: release-gate');
}

export function compare(args: string[], io: CliIo): number {
  void args;
  void io;
  throw new Error('NotImplemented: compare');
}

/** Runs one command; returns the exit code. An unexpected exception is exit 2 with the code
 * `internal` only: no stack trace or absolute path is printed, and it is never read as a gate
 * verdict (exit 1). */
export function main(argv: string[], io: CliIo = processIo): number {
  try {
    const [command, ...rest] = argv;
    if (command === 'smoke-gate') return smokeGate(rest, io);
    if (command === 'identity-fields') return identityFields(rest, io);
    io.err(USAGE);
    return 2;
  } catch {
    io.err('internal -:-\n');
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));

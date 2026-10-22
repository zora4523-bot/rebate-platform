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
//   node packages/evals/src/cli.ts release-gate --cases <dir> --manifest <file> --report <file>
//       --facts <file>
//     The BR-AI-21 release gate on a full run (checkReleaseGate; facts is CaseFacts[] JSON).
//     Load problems: exit 2, prints only code and file basename. Otherwise prints the
//     ReleaseVerdict as one JSON line on stdout and exits 0 (passed) or 1; on failure stderr gets
//     each problem's code, plus the metric id for metric_failed / metric_not_covered, never a
//     case id, case text or problem message.
//
//   node packages/evals/src/cli.ts compare --a <report> --b <report> [--min-sample <n>]
//     Per-vendor comparison (compareReports) as one JSON line on stdout; exit 0, or 1 when the
//     reports ran different eval sets (eval_set_mismatch), 2 for load problems (code and file
//     basename only).
//
// smoke-gate and release-gate also run the identity-field check when the specs file is present next to the
// package (in the repository), so the grader's list cannot drift from BR-AI-03 unnoticed. Only
// ENOENT skips it; an entry there that cannot be read, or a path that cannot be inspected
// (EACCES…), is an `io` load problem (exit 2).
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDuplicateIds,
  checkIdentityFieldsFile,
  checkManifest,
  checkReleaseGate,
  checkSmokeGate,
  compareReports,
  parseJsonl,
  validateManifest,
} from './index.ts';
import type { CaseFacts, EvalCase, Manifest, Problem, Report } from './index.ts';
import { isMetricId, validateFacts } from './release.ts';
import { validateReport } from './report.ts';
import {
  fixedClock,
  recordingsDigest,
  recordingsJsonl,
  runRecord,
  sequentialIds,
} from './record.ts';
import type { EvalClock, EvalIds } from './record.ts';
import { loadRecordings, runReplay } from './replay.ts';
import type { AgentPorts, AgentUnderTest, Recording, ResultCounts, RunMeta } from './types.ts';

export interface CliDeps {
  agent?: (env: { clock: EvalClock; ids: EvalIds }) => AgentUnderTest;
  livePorts?: () => AgentPorts | Promise<AgentPorts>;
  clock?: EvalClock;
  meta?: Pick<
    RunMeta,
    | 'vendor'
    | 'model_snapshot'
    | 'prompt_sha256'
    | 'sampling'
    | 'tool_schema_version'
    | 'code_commit'
    | 'grader_version'
  >;
}

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
  '       cli.ts release-gate --cases <dir> --manifest <file> --report <file> --facts <file>\n' +
  '       cli.ts compare --a <report> --b <report> [--min-sample <n>]\n' +
  '       cli.ts identity-fields [--file <path>]\n' +
  '       record --cases <dir> --manifest <file> --out <dir>      (runCli with an injected agent)\n' +
  '       replay --cases <dir> --manifest <file> --recordings <dir> --report <file>  (runCli)\n';

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

/** Load problems of release-gate and compare: code and file basename only (no line, message or
 * id: they can carry case text). */
function printFileProblems(io: CliIo, problems: readonly Problem[]): void {
  for (const problem of problems) io.err(`${problem.code} ${problem.file ?? '-'}\n`);
}

/** Every *.jsonl in `dir` (sorted by name), with parse and cross-file duplicate-id problems. */
function loadCases(dir: string): { cases: EvalCase[]; problems: Problem[] } {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return { cases: [], problems: [{ code: 'io', file: basename(dir), message: 'cannot read' }] };
  }
  const cases: EvalCase[] = [];
  const files: string[] = [];
  const problems: Problem[] = [];
  for (const name of names) {
    const read = readText(join(dir, name));
    if ('problem' in read) {
      problems.push(read.problem);
      continue;
    }
    const parsed = parseJsonl(read.text, name);
    problems.push(...parsed.problems);
    for (const item of parsed.cases) {
      cases.push(item);
      files.push(name);
    }
  }
  problems.push(...checkDuplicateIds(cases, files));
  return { cases, problems };
}

/** A JSON file whose structure must pass `validate`; a structural problem is `schema <file>`. */
function readChecked(
  path: string,
  validate: (value: unknown) => Problem[],
): { value: unknown } | { problem: Problem } {
  const read = readJson(path);
  if ('problem' in read) return read;
  if (validate(read.value).length > 0) {
    return { problem: { code: 'schema', file: basename(path), message: 'invalid structure' } };
  }
  return read;
}

export function releaseGate(args: string[], io: CliIo): number {
  const flags = parseFlags(args, ['--cases', '--manifest', '--report', '--facts']);
  const casesDir = flags?.get('--cases');
  const manifestPath = flags?.get('--manifest');
  const reportPath = flags?.get('--report');
  const factsPath = flags?.get('--facts');
  if (
    casesDir === undefined ||
    manifestPath === undefined ||
    reportPath === undefined ||
    factsPath === undefined
  ) {
    io.err(USAGE);
    return 2;
  }
  const loadProblems: Problem[] = [...smokeIdentityProblems(DEFAULT_IDENTITY_FILE)];
  const loaded = loadCases(casesDir);
  loadProblems.push(...loaded.problems);
  const manifest = readJson(manifestPath);
  const report = readJson(reportPath);
  const facts = readChecked(factsPath, validateFacts);
  for (const read of [manifest, report, facts])
    if ('problem' in read) loadProblems.push(read.problem);
  if (
    loadProblems.length > 0 ||
    'problem' in manifest ||
    'problem' in report ||
    'problem' in facts
  ) {
    printFileProblems(io, loadProblems);
    return 2;
  }

  const gate = checkReleaseGate(
    report.value as Report,
    manifest.value as Manifest,
    loaded.cases,
    facts.value as CaseFacts[],
  );
  io.out(`${JSON.stringify(gate.verdict)}\n`);
  if (gate.passed) return 0;
  // Only the code, and for metric problems the metric id (checked against the list); never a
  // case id (case_set_mismatch, facts_mismatch…) or a message.
  for (const problem of gate.problems) {
    const metric =
      (problem.code === 'metric_failed' || problem.code === 'metric_not_covered') &&
      isMetricId(problem.message)
        ? ` ${problem.message}`
        : '';
    io.err(`${problem.code}${metric}\n`);
  }
  return 1;
}

export function compare(args: string[], io: CliIo): number {
  const flags = parseFlags(args, ['--a', '--b', '--min-sample']);
  const aPath = flags?.get('--a');
  const bPath = flags?.get('--b');
  const minText = flags?.get('--min-sample');
  if (
    aPath === undefined ||
    bPath === undefined ||
    (minText !== undefined && !/^\d+$/.test(minText))
  ) {
    io.err(USAGE);
    return 2;
  }
  const a = readChecked(aPath, validateReport);
  const b = readChecked(bPath, validateReport);
  if ('problem' in a || 'problem' in b) {
    printFileProblems(
      io,
      [a, b].flatMap((read) => ('problem' in read ? [read.problem] : [])),
    );
    return 2;
  }
  const result = compareReports(
    a.value as Report,
    b.value as Report,
    minText === undefined ? undefined : { minSample: Number(minText) },
  );
  io.out(`${JSON.stringify(result)}\n`);
  if (result.problems.length === 0) return 0;
  for (const problem of result.problems) io.err(`${problem.code}\n`);
  return 1;
}

/** Runs one command; returns the exit code. An unexpected exception is exit 2 with the code
 * `internal` only: no stack trace or absolute path is printed, and it is never read as a gate
 * verdict (exit 1). */
export function main(argv: string[], io: CliIo = processIo): number {
  try {
    const [command, ...rest] = argv;
    if (command === 'smoke-gate') return smokeGate(rest, io);
    if (command === 'release-gate') return releaseGate(rest, io);
    if (command === 'compare') return compare(rest, io);
    if (command === 'identity-fields') return identityFields(rest, io);
    // record / replay need an agent (and live ports) injected through runCli; the bare process
    // entry has none, so it can never write back a pass.
    if (command === 'record' || command === 'replay') {
      io.err('no_agent 1\n');
      return 2;
    }
    io.err(USAGE);
    return 2;
  } catch {
    io.err('internal -:-\n');
    return 2;
  }
}

// ---------------------------------------------------------------------------------------------
// record / replay (B3-01h). Only reachable through runCli, which takes the agent factory, the
// live ports and the clock from code (never from the environment). Output is what BR-AI-21 lets
// a local run write back: one JSON line of counts on stdout and, on stderr, one `<code> <count>`
// line per problem code in code order; never a case id, case text, model output or path.

const DEFAULT_INSTANT = '2000-01-01T00:00:00.000Z';
const ID_PREFIX = 'eval';
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** One `<code> <count>` line per code, ordered by code; codes that do not look like one are
 * counted as `invalid_code` so no free text slips through. */
function printCodes(io: CliIo, codes: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const code of codes) {
    const shown = CODE_PATTERN.test(code) ? code : 'invalid_code';
    counts.set(shown, (counts.get(shown) ?? 0) + 1);
  }
  for (const code of [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    io.err(`${code} ${counts.get(code) ?? 0}\n`);
  }
}

/** Cases and their manifest (checked against them); load problems as codes only. */
function loadCaseSet(
  casesDir: string,
  manifestPath: string,
): { cases: EvalCase[]; manifest: Manifest } | { problems: Problem[] } {
  const loaded = loadCases(casesDir);
  const problems: Problem[] = [...loaded.problems];
  const manifest = readChecked(manifestPath, validateManifest);
  if ('problem' in manifest) problems.push(manifest.problem);
  if (problems.length > 0 || 'problem' in manifest) return { problems };
  const value = manifest.value as Manifest;
  const mismatch = checkManifest(value, loaded.cases);
  if (mismatch.length > 0) return { problems: mismatch };
  return { cases: loaded.cases, manifest: value };
}

function runMeta(
  mode: RunMeta['mode'],
  deps: CliDeps,
  manifest: Manifest,
  clock: EvalClock,
  recordingsSha256: string | null,
): RunMeta {
  const given = deps.meta;
  const at = clock.now().toISOString();
  return {
    mode,
    vendor: given?.vendor ?? 'unspecified',
    model_snapshot: given?.model_snapshot ?? 'unspecified',
    prompt_sha256: given?.prompt_sha256 ?? '0'.repeat(64),
    sampling: { ...(given?.sampling ?? {}) },
    eval_set: {
      set: manifest.set,
      version: manifest.version,
      content_sha256: manifest.content_sha256,
      split_sha256: manifest.split_sha256,
    },
    tool_schema_version: given?.tool_schema_version ?? 'unspecified',
    code_commit: given?.code_commit ?? 'unspecified',
    grader_version: given?.grader_version ?? 'unspecified',
    recordings_sha256: recordingsSha256,
    unused_recordings: 0,
    started_at: at,
    finished_at: at,
  };
}

/** The agent of one run: the factory is called once per case with a fresh id sequence (ids
 * restart at `eval-1` in every case, so one case replays on its own) and the run's clock. */
function perCaseAgent(factory: NonNullable<CliDeps['agent']>, clock: EvalClock): AgentUnderTest {
  const agents = new Map<string, AgentUnderTest>();
  return (input, ports) => {
    let agent = agents.get(input.case_id);
    if (agent === undefined) {
      agent = factory({ clock, ids: sequentialIds(ID_PREFIX) });
      agents.set(input.case_id, agent);
    }
    return agent(input, ports);
  };
}

/** Counts on stdout; exit 0 only when every case passed and nothing else went wrong. */
function finish(io: CliIo, summary: ResultCounts, codes: string[]): number {
  const passed =
    summary.total > 0 &&
    summary.pass === summary.total &&
    summary.fail === 0 &&
    summary.coverage_gap === 0 &&
    summary.error === 0 &&
    codes.length === 0;
  const verdict = {
    passed,
    total: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    coverage_gap: summary.coverage_gap,
    error: summary.error,
  };
  io.out(`${JSON.stringify(verdict)}\n`);
  if (passed) return 0;
  printCodes(io, codes.length > 0 || summary.total > 0 ? codes : ['no_cases']);
  return 1;
}

function writeOut(path: string, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return true;
  } catch {
    return false;
  }
}

async function record(args: string[], deps: CliDeps, io: CliIo): Promise<number> {
  const flags = parseFlags(args, ['--cases', '--manifest', '--out']);
  const casesDir = flags?.get('--cases');
  const manifestPath = flags?.get('--manifest');
  const outDir = flags?.get('--out');
  if (casesDir === undefined || manifestPath === undefined || outDir === undefined) {
    printCodes(io, ['usage']);
    return 2;
  }
  if (deps.agent === undefined) {
    printCodes(io, ['no_agent']);
    return 2;
  }
  if (deps.livePorts === undefined) {
    printCodes(io, ['no_live_ports']);
    return 2;
  }
  const set = loadCaseSet(casesDir, manifestPath);
  if ('problems' in set) {
    printCodes(
      io,
      set.problems.map((problem) => problem.code),
    );
    return 2;
  }
  const clock = deps.clock ?? fixedClock(DEFAULT_INSTANT);
  const live = await deps.livePorts();
  const result = await runRecord({
    cases: set.cases,
    agent: perCaseAgent(deps.agent, clock),
    live,
    meta: runMeta('integration', deps, set.manifest, clock, null),
    clock,
  });
  const wrote =
    writeOut(join(outDir, 'recordings.jsonl'), recordingsJsonl(result.recordings)) &&
    writeOut(join(outDir, 'report.json'), `${JSON.stringify(result.report)}\n`);
  if (!wrote) {
    printCodes(io, ['io']);
    return 2;
  }
  const codes = [
    ...result.report.cases.flatMap((item) => item.problems.map((problem) => problem.code)),
    ...result.problems.map((problem) => problem.code),
  ];
  return finish(io, result.report.summary, codes);
}

/** Every *.jsonl in `dir` as one recording set, so a conflict across files is found too. */
function loadRecordingDir(
  dir: string,
): { text: string; lines: Recording[] } | { problems: Problem[] } {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return { problems: [{ code: 'io', file: basename(dir), message: 'cannot read' }] };
  }
  const texts: string[] = [];
  const problems: Problem[] = [];
  for (const name of names) {
    const read = readText(join(dir, name));
    if ('problem' in read) problems.push(read.problem);
    else texts.push(read.text);
  }
  if (problems.length > 0) return { problems };
  const text = texts.join('\n');
  const loaded = loadRecordings(text, 'recordings');
  if (loaded.problems.length > 0) return { problems: loaded.problems };
  // loadRecordings accepted every non-blank line, so each one parses as a recording.
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Recording);
  return { text, lines };
}

async function replay(args: string[], deps: CliDeps, io: CliIo): Promise<number> {
  const flags = parseFlags(args, ['--cases', '--manifest', '--recordings', '--report']);
  const casesDir = flags?.get('--cases');
  const manifestPath = flags?.get('--manifest');
  const recordingsDir = flags?.get('--recordings');
  const reportPath = flags?.get('--report');
  if (
    casesDir === undefined ||
    manifestPath === undefined ||
    recordingsDir === undefined ||
    reportPath === undefined
  ) {
    printCodes(io, ['usage']);
    return 2;
  }
  if (deps.agent === undefined) {
    printCodes(io, ['no_agent']);
    return 2;
  }
  const set = loadCaseSet(casesDir, manifestPath);
  const recordings = loadRecordingDir(recordingsDir);
  const problems = [
    ...('problems' in set ? set.problems : []),
    ...('problems' in recordings ? recordings.problems : []),
  ];
  if ('problems' in set || 'problems' in recordings) {
    printCodes(
      io,
      problems.map((problem) => problem.code),
    );
    return 2;
  }
  const clock = deps.clock ?? fixedClock(DEFAULT_INSTANT);
  const { store } = loadRecordings(recordings.text, 'recordings');
  const report = await runReplay({
    cases: set.cases,
    agent: perCaseAgent(deps.agent, clock),
    store,
    meta: runMeta('A', deps, set.manifest, clock, recordingsDigest(recordings.lines)),
  });
  if (!writeOut(reportPath, `${JSON.stringify(report)}\n`)) {
    printCodes(io, ['io']);
    return 2;
  }
  const codes = report.cases.flatMap((item) => item.problems.map((problem) => problem.code));
  return finish(io, report.summary, codes);
}

/**
 * The command line with injected dependencies: `record` and `replay` (B3-01h) run here, every
 * other command goes to `main`. Exit 0 all cases passed; 1 a case failed, had a coverage gap or
 * an error, or a recording conflicted; 2 bad arguments, missing agent or live ports, load
 * problems or an unexpected exception (`internal` only).
 */
export async function runCli(
  argv: string[],
  deps: CliDeps,
  io: CliIo = processIo,
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'record') return await record(rest, deps, io);
    if (command === 'replay') return await replay(rest, deps, io);
    return main(argv, io);
  } catch {
    io.err('internal 1\n');
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

// Codex usage ledger: token accounting only (规划/11 §1.3).
//
//   node tools/ops/usage.ts record --run <dir> --task <id> --mode impl|review
//   node tools/ops/usage.ts summary [--json]
//
// The owner said on 2026-10-02 that the Codex quota is unlimited and that no pointless limit is
// to be set (ops/approvals.yaml id 15). This file is therefore telemetry: nothing reads it to
// decide whether a call may run, a failed `record` is only a warning in codex-run.sh, and a
// damaged line is skipped. There is no weekly-quota estimate, no tier and no daily call cap.
// The protections against failures (round limits, the per-task call cap, the consecutive
// no-output breaker) live in tools/ops/state.ts and are computed from the run directory.
//
// The ledger is append-only: couli-runs/usage.jsonl, one JSON object per line with exactly the
// fields of `CallLine`. Lines written by the old quota gate (`weekly_used_percent`) are ignored.
// The token count is input + output of the final turn report and ignores cache discounts and
// service tiers.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readJsonFile } from '../lib/fsx.ts';
import { runsDir } from '../lib/paths.ts';
import { assertTaskId, runMain, UsageError } from './cli.ts';

export type CallMode = 'impl' | 'review';

export type CallLine = {
  at: string;
  task: string;
  mode: CallMode;
  exit_code: number;
  has_output: boolean;
  capacity_error: boolean;
  timed_out: boolean;
  input_tokens: number;
  output_tokens: number;
  thread_id: string | null;
};

/** `skipped` counts lines that are neither a call line nor a legacy quota line. */
export type Ledger = { calls: CallLine[]; skipped: number };

export const CAPACITY_TEXT = 'Selected model is at capacity';

export function ledgerFile(): string {
  return join(runsDir(), 'usage.jsonl');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parses the ledger text. The ledger is telemetry, not a gate input: a damaged line is counted
 * in `skipped` instead of failing, and the calibration lines of the removed quota gate
 * (`weekly_used_percent`) are ignored.
 */
export function parseLedger(text: string): Ledger {
  const ledger: Ledger = { calls: [], skipped: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      ledger.skipped += 1;
      continue;
    }
    if (isObject(doc) && 'weekly_used_percent' in doc) continue;
    if (
      !isObject(doc) ||
      typeof doc.at !== 'string' ||
      Number.isNaN(Date.parse(doc.at)) ||
      typeof doc.task !== 'string' ||
      (doc.mode !== 'impl' && doc.mode !== 'review') ||
      typeof doc.exit_code !== 'number' ||
      typeof doc.has_output !== 'boolean' ||
      typeof doc.capacity_error !== 'boolean' ||
      typeof doc.timed_out !== 'boolean' ||
      typeof doc.input_tokens !== 'number' ||
      typeof doc.output_tokens !== 'number'
    ) {
      ledger.skipped += 1;
      continue;
    }
    ledger.calls.push({
      at: doc.at,
      task: doc.task,
      mode: doc.mode,
      exit_code: doc.exit_code,
      has_output: doc.has_output,
      capacity_error: doc.capacity_error,
      timed_out: doc.timed_out,
      input_tokens: doc.input_tokens,
      output_tokens: doc.output_tokens,
      thread_id: typeof doc.thread_id === 'string' ? doc.thread_id : null,
    });
  }
  return ledger;
}

export function readLedger(): Ledger {
  const file = ledgerFile();
  return parseLedger(existsSync(file) ? readFileSync(file, 'utf8') : '');
}

function appendLine(line: CallLine): void {
  mkdirSync(runsDir(), { recursive: true });
  // One short write with O_APPEND: concurrent writers do not interleave.
  appendFileSync(ledgerFile(), `${JSON.stringify(line)}\n`);
}

export type EventFacts = {
  inputTokens: number;
  outputTokens: number;
  threadId: string | null;
  turnCompleted: boolean;
  capacityError: boolean;
};

/**
 * Reads a `codex exec --json` event stream. Token usage is taken from the LAST
 * `turn.completed` event; lines that are not JSON are ignored (the stream of a
 * killed run can end in the middle of a line).
 */
export function readEvents(eventsText: string, stderrText = ''): EventFacts {
  const facts: EventFacts = {
    inputTokens: 0,
    outputTokens: 0,
    threadId: null,
    turnCompleted: false,
    capacityError: stderrText.includes(CAPACITY_TEXT),
  };
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || typeof event.type !== 'string') continue;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      facts.threadId = event.thread_id;
    }
    if (event.type === 'turn.completed') {
      facts.turnCompleted = true;
      const usage = isObject(event.usage) ? event.usage : {};
      facts.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      facts.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    }
    // Only error events count; quoted file content inside ordinary items is data.
    if ((event.type === 'error' || event.type === 'turn.failed') && line.includes(CAPACITY_TEXT)) {
      facts.capacityError = true;
    }
  }
  return facts;
}

const RUN_FILES: Record<CallMode, { events: string; err: string; output: string }> = {
  impl: { events: 'events.jsonl', err: 'err.txt', output: 'impl.json' },
  review: { events: 'review-events.jsonl', err: 'review-err.txt', output: 'review-codex.json' },
};

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Builds the ledger line for one finished Codex call from its run directory.
 * `meta.<mode>.json` / `meta.json` (written by tools/agent/codex-run.sh) is authoritative for the
 * exit code and the verdicts it contains; what it does not contain is derived
 * from the event stream and the output file.
 */
export function buildCallLine(runDir: string, task: string, mode: CallMode, now: Date): CallLine {
  // codex-run.sh keeps one copy per mode next to meta.json (which is the latest call).
  const perMode = join(runDir, `meta.${mode}.json`);
  const metaFile = existsSync(perMode) ? perMode : join(runDir, 'meta.json');
  if (!existsSync(metaFile)) throw new Error(`${metaFile} does not exist`);
  const meta = readJsonFile(metaFile);
  if (!isObject(meta)) throw new Error(`${metaFile}: not a JSON object`);
  if (typeof meta.mode === 'string' && meta.mode !== mode) {
    throw new Error(`${metaFile}: is for mode ${meta.mode}, not ${mode}`);
  }
  if (typeof meta.task === 'string' && meta.task !== task) {
    throw new Error(`${metaFile}: is for task ${meta.task}, not ${task}`);
  }
  if (typeof meta.exit_code !== 'number') throw new Error(`${metaFile}: exit_code is missing`);
  const files = RUN_FILES[mode];
  const facts = readEvents(
    readIfExists(join(runDir, files.events)),
    readIfExists(join(runDir, files.err)),
  );
  const exitCode = meta.exit_code;
  const hasOutput =
    typeof meta.has_output === 'boolean'
      ? meta.has_output
      : exitCode === 0 && facts.turnCompleted && existsSync(join(runDir, files.output));
  return {
    at: now.toISOString(),
    task,
    mode,
    exit_code: exitCode,
    has_output: hasOutput,
    capacity_error:
      typeof meta.capacity_error === 'boolean' ? meta.capacity_error : facts.capacityError,
    timed_out: typeof meta.timed_out === 'boolean' ? meta.timed_out : exitCode === 124,
    input_tokens: facts.inputTokens,
    output_tokens: facts.outputTokens,
    thread_id:
      typeof meta.thread_id === 'string' && meta.thread_id !== '' ? meta.thread_id : facts.threadId,
  };
}

export function recordCall(
  runDir: string,
  task: string,
  mode: CallMode,
  now: Date = new Date(),
): CallLine {
  const line = buildCallLine(runDir, task, mode, now);
  appendLine(line);
  return line;
}

export type Summary = {
  at: string;
  /** Calls on the current +08:00 calendar day, capacity errors included. No limit applies. */
  calls_today: number;
  /** Input + output tokens of today's calls. */
  tokens_today: number;
  calls_by_task: Record<string, number>;
  tokens_by_task: Record<string, number>;
  /** Ledger lines that could not be read. */
  skipped_lines: number;
};

/** Calendar day in +08:00, the owner's time zone. */
function beijingDay(iso: string | Date): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export function summarize(ledger: Ledger, now: Date): Summary {
  const today = beijingDay(now);
  const callsByTask: Record<string, number> = {};
  const tokensByTask: Record<string, number> = {};
  let callsToday = 0;
  let tokensToday = 0;
  for (const c of ledger.calls) {
    const tokens = c.input_tokens + c.output_tokens;
    callsByTask[c.task] = (callsByTask[c.task] ?? 0) + 1;
    tokensByTask[c.task] = (tokensByTask[c.task] ?? 0) + tokens;
    if (beijingDay(c.at) === today) {
      callsToday += 1;
      tokensToday += tokens;
    }
  }
  return {
    at: now.toISOString(),
    calls_today: callsToday,
    tokens_today: tokensToday,
    calls_by_task: callsByTask,
    tokens_by_task: tokensByTask,
    skipped_lines: ledger.skipped,
  };
}

export function currentSummary(now: Date = new Date()): Summary {
  return summarize(readLedger(), now);
}

function printSummary(s: Summary): void {
  console.log(`今日 Codex 调用：${s.calls_today} 次，${s.tokens_today} token（只记账，不设上限）`);
  const tasks = Object.entries(s.calls_by_task)
    .map(([task, n]) => `${task}=${n} 次 / ${s.tokens_by_task[task] ?? 0} token`)
    .join('，');
  console.log(`各任务累计：${tasks === '' ? '无' : tasks}`);
  if (s.skipped_lines > 0) console.log(`账本里有 ${s.skipped_lines} 行读不出，已跳过`);
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      task: { type: 'string' },
      mode: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const mode = values.mode;
  if (mode !== undefined && mode !== 'impl' && mode !== 'review') {
    throw new UsageError('--mode must be impl or review');
  }

  if (cmd === 'record') {
    if (values.run === undefined || mode === undefined) {
      throw new UsageError('record needs --run <dir> --task <id> --mode impl|review');
    }
    const line = recordCall(values.run, assertTaskId(values.task), mode);
    console.log(JSON.stringify(line));
    return 0;
  }
  if (cmd === 'summary') {
    const s = currentSummary();
    if (values.json) console.log(JSON.stringify(s, null, 2));
    else printSummary(s);
    return 0;
  }
  throw new UsageError('expected: record | summary');
}

if (import.meta.main) runMain(main);

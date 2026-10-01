// Codex usage ledger and circuit breaker (规划/11 §1.3, §2.5).
//
//   node tools/ops/usage.ts record --run <dir> --task <id> --mode impl|review
//   node tools/ops/usage.ts calibrate --weekly-used-percent <n>
//   node tools/ops/usage.ts summary [--json]
//   node tools/ops/usage.ts gate [--task <id>] [--mode impl|review --risk RV0|RV1|RV2]
//       exit 0 = one more Codex call is allowed, 3 = blocked; reason JSON on stdout
//
// The ledger is append-only: couli-runs/usage.jsonl, one JSON object per line.
// A call line has exactly the fields of `CallLine`; a calibration line has
// `weekly_used_percent`.
//
// How the weekly percentage is estimated, and what it cannot know
// ---------------------------------------------------------------
// Codex does not report the weekly quota per call. The orchestrator reads the
// percentage from Codex itself from time to time (the `rate_limits` block of a
// rollout file) and records it with `calibrate`. Between two readings we add
// what our own wrapper spent:
//
//   estimate = last calibrated percent + tokens since that calibration / tokens-per-percent
//
// tokens-per-percent comes from, in this order:
//   1. `tokens_per_percent` in couli-runs/quota.json, when the orchestrator has measured it;
//   2. the last two calibrations, when the percentage rose between them:
//      (our tokens between them) / (percent rise). Other projects on this Mac
//      share the same weekly quota, so our tokens are at most the real total and
//      this slope is at most the real one: the estimate errs on the high side;
//   3. nothing: the estimate stays at the calibrated value (`slope: "none"`).
//
// Limits: usage by other projects after the last calibration is invisible; the
// token count is input + output of the final turn report and ignores cache
// discounts and service tiers; the weekly reset time is not known, a lower
// percentage in a later calibration simply becomes the new baseline. Because of
// all this a calibration older than `calibration_max_age_hours` (quota.json,
// default 24) is not trusted: the tier becomes `unknown` and the gate closes
// (规划/11 §1.3: 读不到额度 = Codex 停用).
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

export type CalibrationLine = { at: string; weekly_used_percent: number };

export type Ledger = { calls: CallLine[]; calibrations: CalibrationLine[] };

export type Tier = 'normal' | 'reduced' | 'stopped' | 'unknown';

/** 规划/11 §2.5 global breaker limits. */
export const MAX_CALLS_PER_DAY = 40;
export const MAX_CALLS_PER_TASK = 6;
export const MAX_CONSECUTIVE_NO_OUTPUT = 3;
/** 规划/11 §1.3 tiers. */
export const REDUCED_FROM_PERCENT = 70;
export const STOPPED_FROM_PERCENT = 90;
const DEFAULT_CALIBRATION_MAX_AGE_HOURS = 24;

export const CAPACITY_TEXT = 'Selected model is at capacity';

export function ledgerFile(): string {
  return join(runsDir(), 'usage.jsonl');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses the ledger text; a malformed line is an error (the ledger is a gate input). */
export function parseLedger(text: string): Ledger {
  const ledger: Ledger = { calls: [], calibrations: [] };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      throw new Error(`usage.jsonl line ${i + 1}: not JSON`);
    }
    if (!isObject(doc) || typeof doc.at !== 'string' || Number.isNaN(Date.parse(doc.at))) {
      throw new Error(`usage.jsonl line ${i + 1}: missing or invalid "at"`);
    }
    if (typeof doc.weekly_used_percent === 'number') {
      ledger.calibrations.push({ at: doc.at, weekly_used_percent: doc.weekly_used_percent });
      continue;
    }
    if (
      typeof doc.task !== 'string' ||
      (doc.mode !== 'impl' && doc.mode !== 'review') ||
      typeof doc.exit_code !== 'number' ||
      typeof doc.has_output !== 'boolean' ||
      typeof doc.capacity_error !== 'boolean' ||
      typeof doc.timed_out !== 'boolean' ||
      typeof doc.input_tokens !== 'number' ||
      typeof doc.output_tokens !== 'number'
    ) {
      throw new Error(`usage.jsonl line ${i + 1}: not a call line`);
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

function appendLine(line: CallLine | CalibrationLine): void {
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

export function calibrate(percent: number, now: Date = new Date()): CalibrationLine {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new UsageError('--weekly-used-percent must be a number between 0 and 100');
  }
  const line: CalibrationLine = { at: now.toISOString(), weekly_used_percent: percent };
  appendLine(line);
  return line;
}

export type QuotaConfig = { tokens_per_percent?: number; calibration_max_age_hours?: number };

export function readQuotaConfig(): QuotaConfig {
  const file = join(runsDir(), 'quota.json');
  if (!existsSync(file)) return {};
  const raw = readJsonFile(file);
  if (!isObject(raw)) throw new Error(`${file}: not a JSON object`);
  const cfg: QuotaConfig = {};
  if (typeof raw.tokens_per_percent === 'number' && raw.tokens_per_percent > 0) {
    cfg.tokens_per_percent = raw.tokens_per_percent;
  }
  if (typeof raw.calibration_max_age_hours === 'number' && raw.calibration_max_age_hours > 0) {
    cfg.calibration_max_age_hours = raw.calibration_max_age_hours;
  }
  return cfg;
}

export type Summary = {
  at: string;
  /** Calls on the current +08:00 calendar day, capacity errors included. */
  calls_today: number;
  calls_by_task: Record<string, number>;
  /** Trailing calls without usable output; capacity errors are skipped. */
  consecutive_no_output: number;
  tokens_since_calibration: number;
  last_calibration: CalibrationLine | null;
  calibration_age_hours: number | null;
  slope: 'quota.json' | 'calibrations' | 'none';
  estimated_weekly_percent: number | null;
  tier: Tier;
};

/** Calendar day in +08:00, the owner's time zone. */
function beijingDay(iso: string | Date): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

function tokensBetween(calls: CallLine[], fromMs: number, toMs: number): number {
  let sum = 0;
  for (const c of calls) {
    const t = Date.parse(c.at);
    if (t >= fromMs && t < toMs) sum += c.input_tokens + c.output_tokens;
  }
  return sum;
}

export function tierOf(percent: number | null): Tier {
  if (percent === null) return 'unknown';
  if (percent >= STOPPED_FROM_PERCENT) return 'stopped';
  if (percent >= REDUCED_FROM_PERCENT) return 'reduced';
  return 'normal';
}

export function summarize(ledger: Ledger, now: Date, quota: QuotaConfig = {}): Summary {
  const today = beijingDay(now);
  const callsByTask: Record<string, number> = {};
  let callsToday = 0;
  for (const c of ledger.calls) {
    callsByTask[c.task] = (callsByTask[c.task] ?? 0) + 1;
    if (beijingDay(c.at) === today) callsToday += 1;
  }

  let consecutive = 0;
  for (let i = ledger.calls.length - 1; i >= 0; i -= 1) {
    const c = ledger.calls[i];
    if (!c) break;
    if (c.capacity_error) continue;
    if (c.has_output) break;
    consecutive += 1;
  }

  const calibrations = [...ledger.calibrations].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = calibrations.at(-1) ?? null;
  const prev = calibrations.at(-2) ?? null;
  const nowMs = now.getTime();

  let estimate: number | null = null;
  let slope: Summary['slope'] = 'none';
  let tokensSince = 0;
  let ageHours: number | null = null;
  if (last) {
    const lastMs = Date.parse(last.at);
    ageHours = (nowMs - lastMs) / 3600_000;
    tokensSince = tokensBetween(ledger.calls, lastMs, Number.POSITIVE_INFINITY);
    let tokensPerPercent: number | null = null;
    if (quota.tokens_per_percent !== undefined) {
      tokensPerPercent = quota.tokens_per_percent;
      slope = 'quota.json';
    } else if (prev && last.weekly_used_percent > prev.weekly_used_percent) {
      const ours = tokensBetween(ledger.calls, Date.parse(prev.at), lastMs);
      if (ours > 0) {
        tokensPerPercent = ours / (last.weekly_used_percent - prev.weekly_used_percent);
        slope = 'calibrations';
      }
    }
    const added = tokensPerPercent === null ? 0 : tokensSince / tokensPerPercent;
    const maxAge = quota.calibration_max_age_hours ?? DEFAULT_CALIBRATION_MAX_AGE_HOURS;
    if (ageHours <= maxAge) {
      estimate = Math.min(100, Math.round((last.weekly_used_percent + added) * 10) / 10);
    }
  }

  return {
    at: now.toISOString(),
    calls_today: callsToday,
    calls_by_task: callsByTask,
    consecutive_no_output: consecutive,
    tokens_since_calibration: tokensSince,
    last_calibration: last,
    calibration_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    slope,
    estimated_weekly_percent: estimate,
    tier: tierOf(estimate),
  };
}

export type GateRequest = { task?: string; mode?: CallMode; risk?: 'RV0' | 'RV1' | 'RV2' };
export type GateReason = { breaker: string; message: string };
export type GateResult = { allowed: boolean; reasons: GateReason[]; summary: Summary };

/**
 * Answers "may one more Codex call be dispatched now?". The limits of 规划/11
 * §2.5 are upper bounds on what has happened, so the gate closes as soon as the
 * next call would cross one: at 40 calls today, at 6 calls for the task, at 3
 * consecutive calls without output. Capacity errors count towards the daily and
 * the per-task totals, not towards the consecutive run.
 */
export function gate(summary: Summary, req: GateRequest = {}): GateResult {
  const reasons: GateReason[] = [];
  if (summary.calls_today >= MAX_CALLS_PER_DAY) {
    reasons.push({
      breaker: 'daily_calls',
      message: `今天已调用 Codex ${summary.calls_today} 次，上限 ${MAX_CALLS_PER_DAY} 次（规划/11 §2.5）；停止全部派工并通知负责人`,
    });
  }
  if (req.task !== undefined) {
    const used = summary.calls_by_task[req.task] ?? 0;
    if (used >= MAX_CALLS_PER_TASK) {
      reasons.push({
        breaker: 'task_calls',
        message: `任务 ${req.task} 已累计调用 ${used} 次，上限 ${MAX_CALLS_PER_TASK} 次（规划/11 §2.5）；任务该拆小或标 blocked`,
      });
    }
  }
  if (summary.consecutive_no_output >= MAX_CONSECUTIVE_NO_OUTPUT) {
    reasons.push({
      breaker: 'no_output',
      message: `连续 ${summary.consecutive_no_output} 次调用没有产出（规划/11 §2.5）；停止全部派工并通知负责人`,
    });
  }
  if (summary.tier === 'stopped') {
    reasons.push({
      breaker: 'quota_stopped',
      message: `估算周额度已用 ${summary.estimated_weekly_percent}%，达到 ${STOPPED_FROM_PERCENT}%：Codex 停用（规划/11 §1.3）`,
    });
  }
  if (summary.tier === 'unknown') {
    reasons.push({
      breaker: 'quota_unknown',
      message:
        (summary.last_calibration
          ? `额度校准已过期（${summary.calibration_age_hours} 小时前）`
          : '额度从未校准') +
        '：读不到额度按停用处理（规划/11 §1.3）。先从 Codex 读出本周已用百分比，再运行 ' +
        '`node tools/ops/usage.ts calibrate --weekly-used-percent <n>`',
    });
  }
  if (
    summary.tier === 'reduced' &&
    req.mode === 'impl' &&
    (req.risk === 'RV0' || req.risk === 'RV1')
  ) {
    reasons.push({
      breaker: 'quota_reduced',
      message: `估算周额度已用 ${summary.estimated_weekly_percent}%（70%–90% 档）：Codex 只做 RV2 实现和评审，${req.risk} 实现改由 Claude 子代理（规划/11 §1.3）`,
    });
  }
  return { allowed: reasons.length === 0, reasons, summary };
}

export function currentSummary(now: Date = new Date()): Summary {
  return summarize(readLedger(), now, readQuotaConfig());
}

function printSummary(s: Summary): void {
  const pct = s.estimated_weekly_percent === null ? '未知' : `${s.estimated_weekly_percent}%`;
  const cal = s.last_calibration
    ? `${s.last_calibration.weekly_used_percent}%（${s.calibration_age_hours} 小时前）`
    : '无';
  console.log(
    `额度档位：${s.tier}；估算周额度已用：${pct}；最近校准：${cal}；斜率来源：${s.slope}`,
  );
  console.log(
    `今日调用：${s.calls_today}/${MAX_CALLS_PER_DAY}；连续无产出：${s.consecutive_no_output}/${MAX_CONSECUTIVE_NO_OUTPUT}；校准后用量：${s.tokens_since_calibration} token`,
  );
  const tasks = Object.entries(s.calls_by_task)
    .map(([task, n]) => `${task}=${n}`)
    .join('，');
  console.log(`各任务累计调用（上限 ${MAX_CALLS_PER_TASK}）：${tasks === '' ? '无' : tasks}`);
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      task: { type: 'string' },
      mode: { type: 'string' },
      risk: { type: 'string' },
      'weekly-used-percent': { type: 'string' },
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
  if (cmd === 'calibrate') {
    const raw = values['weekly-used-percent'];
    if (raw === undefined || !/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
      throw new UsageError('calibrate needs --weekly-used-percent <number>');
    }
    console.log(JSON.stringify(calibrate(Number.parseFloat(raw))));
    return 0;
  }
  if (cmd === 'summary') {
    const s = currentSummary();
    if (values.json) console.log(JSON.stringify(s, null, 2));
    else printSummary(s);
    return 0;
  }
  if (cmd === 'gate') {
    const risk = values.risk;
    if (risk !== undefined && risk !== 'RV0' && risk !== 'RV1' && risk !== 'RV2') {
      throw new UsageError('--risk must be RV0, RV1 or RV2');
    }
    const req: GateRequest = {};
    if (values.task !== undefined) req.task = assertTaskId(values.task);
    if (mode !== undefined) req.mode = mode;
    if (risk !== undefined) req.risk = risk;
    const result = gate(currentSummary(), req);
    console.log(JSON.stringify(result, null, 2));
    for (const r of result.reasons) console.error(`熔断：${r.message}`);
    return result.allowed ? 0 : 3;
  }
  throw new UsageError('expected: record | calibrate | summary | gate');
}

if (import.meta.main) runMain(main);

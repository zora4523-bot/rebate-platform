// Agent eval framework, part 2 (B3-01b): recordings matched by request content and the replay
// runner (mode A). A recording is found by the digest of the full request, never by call order,
// so one request asked twice gets the same response and the order of lines in a recording file
// does not matter. Recordings live in private storage (BR-AI-21); this file only loads them.
import { canonicalJson, compareCodeUnits, sha256Hex } from './canonical.ts';
import { Collector, isObject } from './cases.ts';
import type { EvalCase, Problem } from './cases.ts';
import { IDENTITY_FIELDS, gradeCase } from './grade.ts';
import { summarize } from './report.ts';
import type {
  AgentPorts,
  AgentUnderTest,
  CaseResult,
  ModelRequest,
  Recording,
  Report,
  RunMeta,
  ToolCall,
  TurnOutput,
} from './types.ts';

const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** ISO 8601 date-time with an explicit offset (Z or ±hh:mm). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const KINDS: readonly Recording['kind'][] = ['model', 'tool'];
const DEFAULT_TIMEOUT_MS = 30000;

/** sha256Hex(canonicalJson(req)): independent of object key order; message order matters. */
export function modelKey(req: ModelRequest): string {
  return sha256Hex(canonicalJson(req));
}

/** sha256Hex(canonicalJson(call)) with state.tool_set and state.result_set_ids sorted first
 * (they are sets); every other array keeps its order. The input is not modified. */
export function toolKey(call: ToolCall): string {
  const state = call.state;
  return sha256Hex(
    canonicalJson({
      ...call,
      state: {
        ...state,
        result_set_ids: [...state.result_set_ids].sort(compareCodeUnits),
        tool_set: [...state.tool_set].sort(compareCodeUnits),
      },
    }),
  );
}

/** Thrown when no recording matches a request. */
export class RecordingMiss extends Error {
  readonly kind: Recording['kind'];
  readonly key: string;

  constructor(kind: Recording['kind'], key: string) {
    super(`no ${kind} recording for key ${key}`);
    this.name = 'RecordingMiss';
    this.kind = kind;
    this.key = key;
  }
}

interface StoredRecording {
  kind: Recording['kind'];
  key: string;
  response: unknown;
}

function slot(kind: Recording['kind'], key: string): string {
  return `${kind}:${key}`;
}

/** Recordings looked up by exact content key. Responses are handed back as recorded (a copy). */
export class RecordingStore {
  private readonly entries = new Map<string, StoredRecording>();
  private readonly used = new Set<string>();

  constructor(recordings: readonly StoredRecording[] = []) {
    for (const item of recordings) {
      const id = slot(item.kind, item.key);
      if (!this.entries.has(id)) this.entries.set(id, item);
    }
  }

  private find(kind: Recording['kind'], key: string): unknown {
    const id = slot(kind, key);
    const entry = this.entries.get(id);
    if (entry === undefined) throw new RecordingMiss(kind, key);
    this.used.add(id);
    return structuredClone(entry.response);
  }

  model(req: ModelRequest): unknown {
    return this.find('model', modelKey(req));
  }

  tool(call: ToolCall): unknown {
    return this.find('tool', toolKey(call));
  }

  /** Recordings never looked up so far, ordered by kind then key. */
  unused(): { kind: Recording['kind']; key: string }[] {
    return [...this.entries.entries()]
      .filter(([id]) => !this.used.has(id))
      .map(([, entry]) => ({ kind: entry.kind, key: entry.key }))
      .sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key));
  }
}

/** Strict structural check of one recording line; every problem has code `schema`. */
function validateRecording(value: unknown): Problem[] {
  const c = new Collector(undefined);
  if (!c.object(value, '', ['kind', 'key', 'response', 'recorded_at'], [])) return c.problems;
  if (Object.hasOwn(value, 'kind')) c.oneOf(value['kind'], '/kind', KINDS);
  if (Object.hasOwn(value, 'key')) {
    const key = value['key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      c.add('/key', 'must be a lowercase hex SHA-256');
    }
  }
  if (Object.hasOwn(value, 'recorded_at')) {
    const at = value['recorded_at'];
    if (typeof at !== 'string' || !ISO_WITH_ZONE.test(at) || Number.isNaN(Date.parse(at))) {
      c.add('/recorded_at', 'must be an ISO 8601 date-time with a time zone');
    }
  }
  return c.problems;
}

/**
 * Loads a JSONL recording file. Blank lines are skipped; `line` is the 1-based physical line.
 * Invalid lines are reported (`json`, `schema`) and skipped. The same kind + key twice with a
 * different response (canonical JSON) is `recording_conflict` and the first line wins; the same
 * response twice is kept once without a problem.
 */
export function loadRecordings(
  text: string,
  file: string,
): { store: RecordingStore; problems: Problem[] } {
  const problems: Problem[] = [];
  const kept = new Map<string, { item: StoredRecording; canonical: string; line: number }>();
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const source = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (source.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      problems.push({ code: 'json', file, line, message: `invalid JSON: ${reason}` });
      return;
    }
    const found = validateRecording(value);
    if (found.length > 0 || !isObject(value)) {
      for (const problem of found) problems.push({ ...problem, file, line });
      return;
    }
    const item: StoredRecording = {
      kind: value['kind'] as Recording['kind'],
      key: value['key'] as string,
      response: value['response'],
    };
    // JSON.parse can still yield a value canonical JSON rejects (1e400 is Infinity): that line
    // is a `schema` problem and is skipped, never an exception out of the loader.
    let canonical: string;
    try {
      canonical = canonicalJson(item.response);
    } catch {
      problems.push({
        code: 'schema',
        file,
        line,
        message: '/response: must be a JSON value (no non-finite numbers)',
      });
      return;
    }
    const id = slot(item.kind, item.key);
    const previous = kept.get(id);
    if (previous === undefined) {
      kept.set(id, { item, canonical, line });
    } else if (previous.canonical !== canonical) {
      problems.push({
        code: 'recording_conflict',
        file,
        line,
        message: `${item.kind} recording ${item.key} differs from the one on line ${previous.line}`,
      });
    }
  });
  return { store: new RecordingStore([...kept.values()].map((entry) => entry.item)), problems };
}

// ---------------------------------------------------------------------------------------------
// Runner.

type Outcome =
  { kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/** Runs `start` and settles at the first of: result, error, or `ms` elapsed (no waiting after). */
function settleWithin(start: () => unknown, ms: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), ms);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(start());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => finish({ kind: 'ok', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function describe(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return 'unprintable error';
  }
}

/** Minimal shape needed by the grader; anything else is the agent's error. */
function isTurnOutput(value: unknown): value is TurnOutput {
  if (!isObject(value) || !Array.isArray(value['frames']) || !isObject(value['trace'])) {
    return false;
  }
  const trace = value['trace'];
  const frames = value['frames'] as unknown[];
  const intent = trace['intent'];
  if (intent !== null && typeof intent !== 'string') return false;
  if (!Array.isArray(trace['tool_calls'])) return false;
  const calls = trace['tool_calls'] as unknown[];
  return (
    frames.every((f) => isObject(f) && typeof f['event'] === 'string' && isObject(f['data'])) &&
    calls.every((c) => isObject(c) && typeof c['name'] === 'string' && isObject(c['args']))
  );
}

function stopped(
  c: EvalCase,
  result: 'coverage_gap' | 'error',
  code: string,
  turn: number | null,
  message: string,
): CaseResult {
  return {
    id: c.id,
    category: c.category,
    split: c.split,
    result,
    first_failed_layer: null,
    problems: [{ code, layer: null, turn, message }],
  };
}

function missResult(c: EvalCase, turn: number, miss: RecordingMiss): CaseResult {
  return stopped(c, 'coverage_gap', 'recording_miss', turn, `录制未命中：${miss.kind} ${miss.key}`);
}

/** Recording misses of one case. Every port handed out during the case (a fresh pair per turn)
 * writes here, so a miss through a port the agent cached from an earlier turn of the same
 * conversation still counts. Closed when the case ends. */
interface CaseMisses {
  open: boolean;
  turn: number;
  first: { turn: number; miss: RecordingMiss } | undefined;
}

/** Cases running now, shared by every run of this module (runReplay and runEval alike). A miss
 * through a port whose own case has ended (an agent that caches the first ports it got, in this
 * run or an earlier one, or one still running past its timeout) is recorded on every case
 * running now, so a swallowed miss can never let a case pass; with no case running it is
 * ignored. Sequential runs have at most one such case; overlapping runs only get stricter. */
const runningCases = new Set<CaseMisses>();

function remember(target: CaseMisses, miss: RecordingMiss): void {
  if (target.open && target.first === undefined) target.first = { turn: target.turn, miss };
}

/**
 * Where the ports of one run come from. A port with a live function calls it and hands its
 * result or error to the agent as it is (mode B model, integration model and tool); otherwise
 * the port is served by `store` and every recording miss is tracked (mode A, mode B tool).
 */
export interface PortPlan {
  store: RecordingStore | undefined;
  model: ((req: ModelRequest) => Promise<unknown>) | undefined;
  tool: ((call: ToolCall) => Promise<unknown>) | undefined;
}

/** Only the first miss of a case is kept. */
function wrapPorts(plan: PortPlan, misses: CaseMisses): AgentPorts {
  const lookup = (find: (store: RecordingStore) => unknown): unknown => {
    const store = plan.store;
    if (store === undefined) throw new Error('no recording store for this port');
    try {
      return find(store);
    } catch (error) {
      if (error instanceof RecordingMiss) {
        if (misses.open) remember(misses, error);
        else for (const running of runningCases) remember(running, error);
      }
      throw error;
    }
  };
  const { model, tool } = plan;
  return {
    model: async (req) => (model === undefined ? lookup((store) => store.model(req)) : model(req)),
    tool: async (call) => (tool === undefined ? lookup((store) => store.tool(call)) : tool(call)),
  };
}

/** One case as run: its result and, for a case that reached grading, the outputs of its turns. */
export interface CaseRun {
  case: EvalCase;
  result: CaseResult;
  outputs: TurnOutput[];
}

async function runCase(
  c: EvalCase,
  agent: AgentUnderTest,
  plan: PortPlan,
  timeoutMs: number,
): Promise<CaseRun> {
  const misses: CaseMisses = { open: true, turn: 0, first: undefined };
  const outputs: TurnOutput[] = [];
  runningCases.add(misses);
  try {
    const result = await runTurns(c, agent, plan, timeoutMs, misses, outputs);
    return { case: c, result, outputs };
  } finally {
    misses.open = false;
    runningCases.delete(misses);
  }
}

async function runTurns(
  c: EvalCase,
  agent: AgentUnderTest,
  plan: PortPlan,
  timeoutMs: number,
  misses: CaseMisses,
  outputs: TurnOutput[],
): Promise<CaseResult> {
  for (const [index, step] of c.turns.entries()) {
    const turn = index + 1;
    misses.turn = turn;
    // Every miss is remembered (and still thrown), so a miss the agent swallows, or follows with
    // another error or a timeout, still makes the case a coverage gap.
    const ports = wrapPorts(plan, misses);
    const input = {
      case_id: c.id,
      turn,
      text: step.text,
      untrusted: step.untrusted ?? false,
      subject: c.subject,
      switches: { ...(c.switches ?? {}) },
    };
    const outcome = await settleWithin(() => agent(input, ports), timeoutMs);
    if (misses.first !== undefined) return missResult(c, misses.first.turn, misses.first.miss);
    if (outcome.kind === 'timeout') {
      return stopped(c, 'error', 'timeout', turn, `第 ${turn} 轮超过 ${timeoutMs} ms 未完成`);
    }
    if (outcome.kind === 'error') {
      if (outcome.error instanceof RecordingMiss) return missResult(c, turn, outcome.error);
      return stopped(c, 'error', 'agent_error', turn, describe(outcome.error));
    }
    let output: unknown;
    try {
      output = structuredClone(outcome.value);
    } catch (error) {
      return stopped(c, 'error', 'agent_error', turn, `输出无法复制：${describe(error)}`);
    }
    if (!isTurnOutput(output)) {
      return stopped(c, 'error', 'agent_error', turn, '输出不符合 TurnOutput 结构');
    }
    outputs.push(output);
  }
  try {
    return gradeCase(c, outputs, IDENTITY_FIELDS);
  } catch (error) {
    return stopped(c, 'error', 'agent_error', null, `判分失败：${describe(error)}`);
  }
}

/** `timeoutMs` when it is a finite number ≥ 0, else the default (30000). */
export function effectiveTimeout(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

/**
 * The runner shared by runReplay and runEval: the active cases in id order (UTF-16 code units),
 * turn by turn, with ports from `plan`; one case failing never stops the others.
 */
export async function runCases(
  cases: readonly EvalCase[],
  agent: AgentUnderTest,
  plan: PortPlan,
  timeoutMs: number,
): Promise<CaseRun[]> {
  const active = cases
    .filter((item) => item.retired === undefined)
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  const runs: CaseRun[] = [];
  for (const c of active) runs.push(await runCase(c, agent, plan, timeoutMs));
  return runs;
}

/** The report of a run: meta as given except `unused_recordings`. */
export function buildReport(meta: RunMeta, results: CaseResult[], unused: number): Report {
  return {
    schema_version: 1,
    meta: { ...meta, unused_recordings: unused },
    cases: results,
    summary: summarize(results),
  };
}

/**
 * Replays the active cases in id order (UTF-16 code units), turn by turn, against `agent` with
 * ports served by `store`; one case failing never stops the others. A recording miss in a turn
 * (thrown, swallowed or followed by another error) makes the case `coverage_gap` and skips its
 * later turns; another error or `timeoutMs` (default 30000) makes it `error`; otherwise the
 * case is graded with the package's identity field list.
 */
export async function runReplay(opts: {
  cases: EvalCase[];
  agent: AgentUnderTest;
  store: RecordingStore;
  meta: RunMeta;
  timeoutMs?: number;
}): Promise<Report> {
  const plan: PortPlan = { store: opts.store, model: undefined, tool: undefined };
  const runs = await runCases(opts.cases, opts.agent, plan, effectiveTimeout(opts.timeoutMs));
  return buildReport(
    opts.meta,
    runs.map((run) => run.result),
    opts.store.unused().length,
  );
}

// Agent eval framework, part 2 (B3-01b): recordings matched by request content and the replay
// runner (mode A). A recording is found by the digest of the full request, never by call order,
// so one request asked twice gets the same response and the order of lines in a recording file
// does not matter. Recordings live in private storage (BR-AI-21); this file only loads them.
import { AsyncLocalStorage } from 'node:async_hooks';
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

/** Recording misses of one case run. Closed when the case ends; a closed case records nothing. */
interface CaseMisses {
  open: boolean;
  turn: number;
  first: { turn: number; miss: RecordingMiss } | undefined;
}

/** One run of runCases: its port plan, and whether it is still going (B3-01c §16). */
interface RunState {
  plan: PortPlan;
  open: boolean;
}

/** The case an agent call is made for. Every agent call runs inside caseContext.run, so the
 * context follows all of that call's async work (awaits, timers, background tasks). */
interface CaseContext {
  runId: number;
  caseId: string;
  misses: CaseMisses;
  run: RunState;
}

/** Attributes a recording miss to the case whose agent call made the port call, whatever port
 * was used: one handed out in an earlier turn, case or run (an agent that caches its first
 * ports) counts against the case running that call (B3-01c §14). When that case has ended (a
 * long-lived task the agent started in an earlier case) the miss goes to the case the port was
 * handed to while it runs (B3-01c §16); a late call (past its timeout) on its own ended case's
 * port records nothing, so it can never touch a later case or run. */
const caseContext = new AsyncLocalStorage<CaseContext>();
let lastRunId = 0;

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

/** Only the first miss of a case is kept. A miss goes to the case of the calling context while
 * it runs, else to the case the port was handed to while that one runs (see caseContext); a call
 * that carries no context at all (the agent lost it, e.g. a thenable resolved by the runner)
 * goes to the port's case too. Data comes from the plan of the run the call belongs to: the
 * calling context's run while it is going (a port cached in an earlier run, even one of another
 * mode, serves the current run's sources), else the plan the port was made with (B3-01c §16). */
function wrapPorts(own: CaseContext): AgentPorts {
  const planOf = (): PortPlan => {
    const current = caseContext.getStore();
    return current !== undefined && current.run.open ? current.run.plan : own.run.plan;
  };
  const lookup = (plan: PortPlan, find: (store: RecordingStore) => unknown): unknown => {
    const store = plan.store;
    if (store === undefined) throw new Error('no recording store for this port');
    try {
      return find(store);
    } catch (error) {
      if (error instanceof RecordingMiss) {
        const current = caseContext.getStore();
        remember(current !== undefined && current.misses.open ? current.misses : own.misses, error);
      }
      throw error;
    }
  };
  return {
    model: async (req) => {
      const plan = planOf();
      return plan.model === undefined ? lookup(plan, (store) => store.model(req)) : plan.model(req);
    },
    tool: async (call) => {
      const plan = planOf();
      return plan.tool === undefined ? lookup(plan, (store) => store.tool(call)) : plan.tool(call);
    },
  };
}

/** One case as run: its result and every well-formed output the agent returned, in turn order.
 * A case that reached grading has one per turn; a stopped case (coverage_gap, error) has those of
 * the turns before it stopped, plus the stopping turn's when the agent returned one after a
 * swallowed recording miss (its text was emitted all the same). For an output that is not a
 * well-formed TurnOutput (which always stops the case, as error or, after a swallowed miss, as
 * coverage_gap), `leakOnly` holds what the leak checks can still read of it (its frames and tool
 * calls, B3-01c §16) and `checkOnly` what the card and link checks can still read of it (its
 * card frames, card sources and link registrations, B3-01d). */
export interface CaseRun {
  case: EvalCase;
  result: CaseResult;
  outputs: TurnOutput[];
  leakOnly: TurnOutput[];
  checkOnly: TurnOutput[];
}

async function runCase(
  c: EvalCase,
  agent: AgentUnderTest,
  run: RunState,
  timeoutMs: number,
  runId: number,
): Promise<CaseRun> {
  const misses: CaseMisses = { open: true, turn: 0, first: undefined };
  const context: CaseContext = { runId, caseId: c.id, misses, run };
  const outputs: TurnOutput[] = [];
  const leakOnly: TurnOutput[] = [];
  const checkOnly: TurnOutput[] = [];
  try {
    const result = await runTurns(c, agent, timeoutMs, context, { outputs, leakOnly, checkOnly });
    return { case: c, result, outputs, leakOnly, checkOnly };
  } finally {
    misses.open = false;
  }
}

/** A copy of what the agent returned when it is a well-formed TurnOutput, else the reason. */
function copyOutput(value: unknown): { output: TurnOutput } | { problem: string } {
  let output: unknown;
  try {
    output = structuredClone(value);
  } catch (error) {
    return { problem: `输出无法复制：${describe(error)}` };
  }
  return isTurnOutput(output) ? { output } : { problem: '输出不符合 TurnOutput 结构' };
}

/** A copy of a value, or the value itself when it cannot be copied. */
function copyOr(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** What the leak checks can still read of an output that is not a well-formed TurnOutput: the
 * frames that have a string event and an object data (text.delta keeps only a string delta),
 * and, when trace.tool_calls is an array, its object entries. Undefined when neither frames nor
 * tool_calls is an array (B3-01c §16: text already emitted still counts). */
function leakView(value: unknown): TurnOutput | undefined {
  try {
    if (!isObject(value)) return undefined;
    const rawFrames = value['frames'];
    const trace = value['trace'];
    const rawCalls = isObject(trace) ? trace['tool_calls'] : undefined;
    if (!Array.isArray(rawFrames) && !Array.isArray(rawCalls)) return undefined;
    const frames: TurnOutput['frames'] = [];
    for (const item of Array.isArray(rawFrames) ? (rawFrames as unknown[]) : []) {
      if (!isObject(item) || typeof item['event'] !== 'string' || !isObject(item['data'])) continue;
      const delta = item['data']['delta'];
      frames.push({
        event: item['event'],
        id: frames.length + 1,
        data: typeof delta === 'string' ? { delta } : {},
      });
    }
    const calls: TurnOutput['trace']['tool_calls'] = [];
    for (const item of Array.isArray(rawCalls) ? (rawCalls as unknown[]) : []) {
      if (!isObject(item)) continue;
      const name = item['name'];
      // Only the keys of args are read (identity_arg); a value that is not an object finds none.
      calls.push({
        name: typeof name === 'string' ? name : '',
        args: copyOr(item['args']) as Record<string, unknown>,
        status: 'ok',
      });
    }
    return { frames, trace: { intent: null, tool_calls: calls } };
  } catch {
    return undefined;
  }
}

/** A plain copy of what `read` returns (a structured clone, else a JSON round trip, which is what
 * the stream would carry); undefined when it cannot be read or copied. */
function detached(read: () => unknown): unknown {
  try {
    const value = read();
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as unknown;
    }
  } catch {
    return undefined;
  }
}

/** What the card and link checks can still read of an output that is not a well-formed
 * TurnOutput (B3-01d): every card frame, that is an object with event "card" and an object data
 * (the frames computeFacts reads in a well-formed output; no frame id or seq is needed), and,
 * when trace is an object, that turn's own trace.card_sources and trace.link_registrations when
 * they are arrays. Each frame is read and copied on its own, so one that cannot be read is
 * skipped without losing the others; sources or registrations that cannot be read are left out,
 * which leaves the cards unverified. Undefined when no card frame is readable (no card, no
 * count). The leak checks keep using leakView. */
function checkView(value: unknown): TurnOutput | undefined {
  try {
    if (!isObject(value)) return undefined;
    const rawFrames = value['frames'];
    if (!Array.isArray(rawFrames)) return undefined;
    const items = rawFrames as unknown[];
    const length = items.length;
    const frames: TurnOutput['frames'] = [];
    for (let index = 0; index < length; index += 1) {
      const item = detached(() => items[index]);
      if (!isObject(item) || item['event'] !== 'card') continue;
      const data = item['data'];
      if (isObject(data)) frames.push({ event: 'card', id: frames.length + 1, data });
    }
    if (frames.length === 0) return undefined;
    let rawTrace: unknown;
    try {
      rawTrace = value['trace'];
    } catch {
      rawTrace = undefined;
    }
    const field = (key: string): unknown =>
      detached(() => (isObject(rawTrace) ? rawTrace[key] : undefined));
    const trace: TurnOutput['trace'] = { intent: null, tool_calls: [] };
    const sources = field('card_sources');
    if (Array.isArray(sources)) {
      trace.card_sources = sources as NonNullable<TurnOutput['trace']['card_sources']>;
    }
    const registrations = field('link_registrations');
    if (Array.isArray(registrations)) {
      trace.link_registrations = registrations as NonNullable<
        TurnOutput['trace']['link_registrations']
      >;
    }
    return { frames, trace };
  } catch {
    return undefined;
  }
}

/** Where runTurns puts the outputs of a case (see CaseRun). */
interface TurnSinks {
  outputs: TurnOutput[];
  leakOnly: TurnOutput[];
  checkOnly: TurnOutput[];
}

async function runTurns(
  c: EvalCase,
  agent: AgentUnderTest,
  timeoutMs: number,
  context: CaseContext,
  sinks: TurnSinks,
): Promise<CaseResult> {
  const { outputs, leakOnly, checkOnly } = sinks;
  const misses = context.misses;
  for (const [index, step] of c.turns.entries()) {
    const turn = index + 1;
    misses.turn = turn;
    // Every miss is remembered (and still thrown), so a miss the agent swallows, or follows with
    // another error or a timeout, still makes the case a coverage gap.
    const ports = wrapPorts(context);
    const input = {
      case_id: c.id,
      turn,
      text: step.text,
      untrusted: step.untrusted ?? false,
      subject: c.subject,
      switches: { ...(c.switches ?? {}) },
    };
    const outcome = await settleWithin(
      () => caseContext.run(context, () => agent(input, ports)),
      timeoutMs,
    );
    const copied = outcome.kind === 'ok' ? copyOutput(outcome.value) : undefined;
    // Kept before the miss check, so a malformed output after a swallowed miss (coverage_gap)
    // counts the same as one that stops the case as agent_error (B3-01d).
    if (outcome.kind === 'ok' && copied !== undefined && 'problem' in copied) {
      const view = leakView(outcome.value);
      if (view !== undefined) leakOnly.push(view);
      const cards = checkView(outcome.value);
      if (cards !== undefined) checkOnly.push(cards);
    }
    if (misses.first !== undefined) {
      if (copied !== undefined && 'output' in copied) outputs.push(copied.output);
      return missResult(c, misses.first.turn, misses.first.miss);
    }
    if (outcome.kind === 'timeout') {
      return stopped(c, 'error', 'timeout', turn, `第 ${turn} 轮超过 ${timeoutMs} ms 未完成`);
    }
    if (outcome.kind === 'error') {
      if (outcome.error instanceof RecordingMiss) return missResult(c, turn, outcome.error);
      return stopped(c, 'error', 'agent_error', turn, describe(outcome.error));
    }
    if (copied === undefined || 'problem' in copied) {
      return stopped(
        c,
        'error',
        'agent_error',
        turn,
        copied?.problem ?? '输出不符合 TurnOutput 结构',
      );
    }
    outputs.push(copied.output);
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
  lastRunId += 1;
  const runId = lastRunId;
  const run: RunState = { plan, open: true };
  const runs: CaseRun[] = [];
  try {
    for (const c of active) runs.push(await runCase(c, agent, run, timeoutMs, runId));
  } finally {
    run.open = false;
  }
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

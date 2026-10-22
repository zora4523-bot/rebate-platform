// Agent eval framework, recording side (B3-01h, BR-AI-21). Real model and tool calls go through
// an injectable writer that keeps one line per content key (schema/recording.schema.json), keyed
// exactly as replay looks them up (modelKey / toolKey over the request the agent handed to the
// port), so a recorded run replays without misses. Only a redacted copy of each response is
// written: identity fields (BR-AI-03) and auth headers are dropped at every level. Time and ids
// come only from the injected EvalClock / EvalIds, so recording twice gives the same keys.
import { canonicalJson, compareCodeUnits, sha256Hex } from './canonical.ts';
import type { EvalCase, Problem } from './cases.ts';
import { IDENTITY_FIELDS, normalizeIdentityKey } from './grade.ts';
import { runEval } from './release.ts';
import { modelKey, toolKey } from './replay.ts';
import type { AgentPorts, AgentUnderTest, Recording, Report, RunMeta } from './types.ts';

export interface EvalClock {
  now(): Date;
}

export interface EvalIds {
  next(): string;
}

/** A clock that always reads the instant `iso` (any ISO 8601 form Date.parse accepts). */
export function fixedClock(iso: string): EvalClock {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError('fixedClock: not a valid date-time');
  return { now: () => new Date(ms) };
}

/** `<prefix>-1`, `<prefix>-2`, …; each instance counts on its own. */
export function sequentialIds(prefix: string): EvalIds {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}

/** Auth header names (lower case) never written to a recording. */
function authKeys(): ReadonlySet<string> {
  return new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'api_key',
    'apikey',
    'cookie',
    'set-cookie',
  ]);
}

function identityKeys(): ReadonlySet<string> {
  return new Set(IDENTITY_FIELDS.map(normalizeIdentityKey));
}

function redactWith(
  value: unknown,
  identity: ReadonlySet<string>,
  auth: ReadonlySet<string>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactWith(item, identity, auth));
  const record = value as Record<string, unknown>;
  // Object.fromEntries defines own data properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => !identity.has(normalizeIdentityKey(key)) && !auth.has(key.toLowerCase()))
      .map((key) => [key, redactWith(record[key], identity, auth)]),
  );
}

/** A deep copy of `value` without identity fields (matched after normalizeIdentityKey) and auth
 * headers (case-insensitive) at any depth; arrays keep their order, the input is not changed. */
export function redactRecorded(value: unknown): unknown {
  return redactWith(value, identityKeys(), authKeys());
}

export interface RecordingWriter {
  wrap(ports: AgentPorts): AgentPorts;
  lines(): Recording[];
  problems(): Problem[];
  toJsonl(): string;
}

function byKindKey(a: Recording, b: Recording): number {
  return compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key);
}

/** One canonical JSON line per recording, ordered by kind then key, each ending in a newline. */
export function recordingsJsonl(lines: readonly Recording[]): string {
  return [...lines]
    .sort(byKindKey)
    .map((line) => `${canonicalJson(line)}\n`)
    .join('');
}

/** meta.recordings_sha256 of mode A: SHA-256 of the canonical lines ordered by kind then key,
 * the first line of a kind + key kept (the one RecordingStore serves). */
export function recordingsDigest(lines: readonly Recording[]): string {
  const first = new Map<string, Recording>();
  for (const line of lines) {
    const id = `${line.kind}:${line.key}`;
    if (!first.has(id)) first.set(id, line);
  }
  return sha256Hex(recordingsJsonl([...first.values()]));
}

/**
 * A writer whose wrapped ports call the given ports and record one line per kind + key: the key
 * of the request as the agent handed it, a redacted copy of the response and the clock's time.
 * The agent gets the port's own response or error unchanged; an error writes nothing. The same
 * key again with the same redacted response is kept once; with a different one the first stays
 * and `recording_conflict` is reported (as loadRecordings does).
 */
export function createRecordingWriter(opts: { clock: EvalClock }): RecordingWriter {
  const kept = new Map<string, { line: Recording; canonical: string }>();
  const found: Problem[] = [];

  const record = (kind: Recording['kind'], key: string, response: unknown): void => {
    let copy: unknown;
    let canonical: string;
    try {
      copy = redactRecorded(response);
      canonical = canonicalJson(copy);
    } catch {
      found.push({ code: 'recording_unserializable', message: `${kind} response is not JSON` });
      return;
    }
    const id = `${kind}:${key}`;
    const previous = kept.get(id);
    if (previous === undefined) {
      const line: Recording = {
        kind,
        key,
        response: JSON.parse(canonical) as unknown,
        recorded_at: opts.clock.now().toISOString(),
      };
      kept.set(id, { line, canonical });
    } else if (previous.canonical !== canonical) {
      found.push({
        code: 'recording_conflict',
        message: `${kind} recording ${key} differs from the first response`,
      });
    }
  };

  const lines = (): Recording[] =>
    [...kept.values()].map((entry) => structuredClone(entry.line)).sort(byKindKey);

  return {
    wrap: (ports) => ({
      model: async (req) => {
        const key = modelKey(req);
        const response = await ports.model(req);
        record('model', key, response);
        return response;
      },
      tool: async (call) => {
        const key = toolKey(call);
        const response = await ports.tool(call);
        record('tool', key, response);
        return response;
      },
    }),
    lines,
    problems: () => found.map((problem) => ({ ...problem })),
    toJsonl: () => recordingsJsonl(lines()),
  };
}

/**
 * Runs the cases in integration mode against `live` (runEval: the runner sets the case's trusted
 * provenance on live model calls) while recording every call the agent makes, keyed by the
 * request the agent made, before the runner adds provenance, so runReplay finds it.
 */
export async function runRecord(opts: {
  cases: EvalCase[];
  agent: AgentUnderTest;
  live: AgentPorts;
  meta: RunMeta;
  clock: EvalClock;
  timeoutMs?: number;
}): Promise<{ report: Report; recordings: Recording[]; problems: Problem[] }> {
  const writer = createRecordingWriter({ clock: opts.clock });
  const agent: AgentUnderTest = (input, ports) => opts.agent(input, writer.wrap(ports));
  const { report } = await runEval({
    cases: opts.cases,
    agent,
    meta: { ...opts.meta, mode: 'integration', recordings_sha256: null },
    live: opts.live,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  return { report, recordings: writer.lines(), problems: writer.problems() };
}

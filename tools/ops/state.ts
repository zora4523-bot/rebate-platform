// In-flight task state (规划/11 §2.1, §2.2, §2.5; planning docs/templates/task-ledger.md §3).
// Lives outside the repository in couli-runs/state/<id>.json; never committed.
//
//   node tools/ops/state.ts get <id>
//   node tools/ops/state.ts set <id> [--state <s>] [--spec-commit <sha>|none] [--pid <n>|none]
//                                    [--started-at <iso>] [--last-error <path>|none]
//   node tools/ops/state.ts claim <id> [--owner <session>] [--renew]
//   node tools/ops/state.ts release <id> [--owner <session>]
//   node tools/ops/state.ts bump-attempt <id> impl
//   node tools/ops/state.ts bump-attempt <id> review --review-type money|general|contract|spec-test
//   node tools/ops/state.ts settle <id> --meta <meta.json>
//   node tools/ops/state.ts migrate <id> [--unattributed-review spec-test|code] [--dry-run]
//
// Rounds (规划/11 §2.5, owner decision 2026-10-02, ops/approvals.yaml id 13):
// - three counters with their own limits: implementation 3, spec-test review 2, code review
//   (money / general / contract) 2;
// - a counter is bumped BEFORE the call (a run that dies without a trace stays counted);
// - `settle`, run by tools/agent/codex-run.sh after every call, takes the bump back when the
//   call ended without output: hard timeout or inactivity kill (exit 124), model capacity error
//   (exit 11), or exit 10 before an answer could be validated (no `-o` file, no
//   `turn.completed` / `turn.failed`, Codex exit non-zero, aborted, processes left behind). Such
//   a call still counts towards the per-task Codex call cap and the no-output breaker (below).
//   An answer that failed validation (exit 10, validation "failed") and a position assertion
//   failure (exit 12) stay counted.
//
// Failure breakers (规划/11 §2.5; owner 2026-10-02: the Codex quota is unlimited, only failures
// stop a task, ops/approvals.yaml id 15). `bump-attempt` refuses with exit 3 when either is open:
// - at most 10 Codex calls per task (a runaway-loop breaker): every finished call counts, also
//   one that ended without output and gave its round back;
// - 3 calls of the task in a row that ended without output stop the task. A capacity error
//   neither extends nor ends such a run.
// Both are computed from the task's finished calls in <runs>/<id>/ (meta.<mode>.json and
// attempts/<n>/meta.json); there is no daily cap and no quota tier.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readJsonFile, writeFileAtomic } from '../lib/fsx.ts';
import { runsDir } from '../lib/paths.ts';
import { assertTaskId, BreakerError, CheckError, runMain, UsageError } from './cli.ts';
import { acquireLock, heartbeatLock, LEASE_MS, lockStatus } from './lock.ts';

export const STATES = [
  'ready',
  'spec',
  'doing',
  'verify',
  'review',
  'longrun',
  'pr',
  'blocked',
  'ask',
  'stale',
] as const;
export type StateName = (typeof STATES)[number];

export const ATTEMPT_KINDS = ['impl', 'spec-test', 'code'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/** 规划/11 §2.5: 3 implementation attempts; 2 rounds per review type (spec-test, code). */
export const ATTEMPT_LIMITS: Record<AttemptKind, number> = { impl: 3, 'spec-test': 2, code: 2 };

export const REVIEW_TYPES = ['money', 'general', 'contract', 'spec-test'] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

/** The rule-test review has its own counter; money, general and contract are code reviews. */
export function reviewKind(type: ReviewType): AttemptKind {
  return type === 'spec-test' ? 'spec-test' : 'code';
}

/** A Codex call whose pre-counted round was taken back by `settle`. */
export type UncountedCall = {
  kind: AttemptKind;
  /** `started_at` of the call's meta.json; identifies the call, so settling is idempotent. */
  started_at: string;
  exit_code: number;
  reason: 'timeout' | 'inactivity-kill' | 'capacity' | 'no-output';
};

export type TaskState = {
  id: string;
  state: StateName;
  attempts: Record<AttemptKind, number>;
  /** Commit of the rule tests; they must not change afterwards. */
  spec_commit: string | null;
  /** Current background run. */
  pid: number | null;
  started_at: string | null;
  owner_session: string | null;
  lease_until: string | null;
  /** When the task entered `ask`, for the 24 h / 72 h follow-up. */
  ask_created_at: string | null;
  /** Path of the output file of the previous failed round. */
  last_error: string | null;
  /** Calls that ended without output and therefore did not use up a round. */
  uncounted_calls: UncountedCall[];
  updated_at: string;
};

export function stateDir(): string {
  return join(runsDir(), 'state');
}

export function stateFile(id: string): string {
  return join(stateDir(), `${id}.json`);
}

export function claimDir(id: string): string {
  return join(runsDir(), 'claims', id);
}

function initialState(id: string, now: Date): TaskState {
  return {
    id,
    state: 'ready',
    attempts: { impl: 0, 'spec-test': 0, code: 0 },
    spec_commit: null,
    pid: null,
    started_at: null,
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
    uncounted_calls: [],
    updated_at: now.toISOString(),
  };
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** Validates a state document; throws with the file name on the first problem. */
export function parseState(raw: unknown, file: string): TaskState {
  const bad = (what: string): never => {
    throw new Error(`${file}: ${what}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') bad('id must be a string');
  if (typeof o.state !== 'string' || !(STATES as readonly string[]).includes(o.state)) {
    bad(`state must be one of ${STATES.join(', ')}`);
  }
  const attempts = o.attempts as Record<string, unknown> | undefined;
  if (typeof attempts !== 'object' || attempts === null) bad('attempts must be an object');
  if (attempts !== undefined && 'review' in attempts) {
    bad(
      'attempts uses the old shape {impl, review} (one shared review counter); ' +
        `convert it with: node tools/ops/state.ts migrate ${String(o.id)}`,
    );
  }
  const keys = Object.keys(attempts ?? {}).sort();
  if (
    keys.join(',') !== [...ATTEMPT_KINDS].sort().join(',') ||
    !ATTEMPT_KINDS.every((k) => isCount(attempts?.[k]))
  ) {
    bad(`attempts must have exactly ${ATTEMPT_KINDS.join(', ')} as non-negative integers`);
  }
  if (!Array.isArray(o.uncounted_calls)) {
    bad(
      `uncounted_calls must be an array (old state file? run: node tools/ops/state.ts migrate ${String(o.id)})`,
    );
  }
  (o.uncounted_calls as unknown[]).forEach((c, i) => {
    const e = c as Record<string, unknown>;
    if (
      typeof c !== 'object' ||
      c === null ||
      !(ATTEMPT_KINDS as readonly unknown[]).includes(e.kind) ||
      typeof e.started_at !== 'string' ||
      typeof e.exit_code !== 'number' ||
      typeof e.reason !== 'string'
    ) {
      bad(`uncounted_calls[${i}] must be {kind, started_at, exit_code, reason}`);
    }
  });
  if (!(o.pid === null || isCount(o.pid))) bad('pid must be an integer or null');
  for (const key of [
    'spec_commit',
    'started_at',
    'owner_session',
    'lease_until',
    'ask_created_at',
    'last_error',
  ]) {
    if (!isNullableString(o[key])) bad(`${key} must be a string or null`);
  }
  if (typeof o.updated_at !== 'string') bad('updated_at must be a string');
  return raw as TaskState;
}

export function readState(id: string): TaskState | null {
  const file = stateFile(id);
  if (!existsSync(file)) return null;
  const state = parseState(readJsonFile(file), file);
  if (state.id !== id) throw new Error(`${file}: id "${state.id}" does not match the file name`);
  return state;
}

export function listStates(): TaskState[] {
  const dir = stateDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      return parseState(readJsonFile(file), file);
    });
}

/** Temp file + rename, so a reader never sees a half-written state. */
export function writeState(state: TaskState): void {
  writeFileAtomic(stateFile(state.id), `${JSON.stringify(state, null, 2)}\n`);
}

export type StatePatch = Partial<
  Omit<TaskState, 'id' | 'attempts' | 'uncounted_calls' | 'updated_at' | 'ask_created_at'>
>;

export function updateState(id: string, patch: StatePatch, now: Date = new Date()): TaskState {
  const prev = readState(id) ?? initialState(id, now);
  const next: TaskState = { ...prev, ...patch, updated_at: now.toISOString() };
  if (next.state === 'ask' && prev.state !== 'ask') next.ask_created_at = now.toISOString();
  if (next.state !== 'ask') next.ask_created_at = null;
  if (patch.pid !== undefined && patch.pid !== null && patch.started_at === undefined) {
    next.started_at = now.toISOString();
  }
  if (patch.pid === null) next.started_at = null;
  writeState(next);
  return next;
}

/**
 * Counts an attempt BEFORE the dispatch (规划/11 §2.5), so that a run that dies
 * without a trace is still counted. Past the limit nothing is written. An open failure
 * breaker (`taskCalls`) refuses first, with BreakerError (exit 3).
 */
export function bumpAttempt(id: string, kind: AttemptKind, now: Date = new Date()): TaskState {
  const calls = taskCalls(id);
  if (calls.reasons.length > 0) {
    throw new BreakerError(calls.reasons.map((r) => r.message).join('\n'));
  }
  const prev = readState(id) ?? initialState(id, now);
  const used = prev.attempts[kind];
  if (used >= ATTEMPT_LIMITS[kind]) {
    throw new CheckError(
      `${id}: ${kind} attempts exhausted (${used} of ${ATTEMPT_LIMITS[kind]}, 规划/11 §2.5)`,
    );
  }
  const next: TaskState = {
    ...prev,
    attempts: { ...prev.attempts, [kind]: used + 1 },
    updated_at: now.toISOString(),
  };
  writeState(next);
  return next;
}

/** The fields of a codex-run.sh meta.json that `settle` and `migrate` read. */
export type CallMeta = {
  mode: 'impl' | 'review';
  review_type: ReviewType | null;
  started_at: string;
  exit_code: number;
  has_output: boolean;
  idle_killed: boolean;
  validation: string | null;
};

/** Reads a finished meta.json; null when it is not one (still running, or not a call). */
export function parseCallMeta(raw: unknown): CallMeta | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.mode !== 'impl' && m.mode !== 'review') return null;
  if (typeof m.started_at !== 'string' || typeof m.exit_code !== 'number') return null;
  if (typeof m.finished_at !== 'string') return null;
  const type = (REVIEW_TYPES as readonly unknown[]).includes(m.review_type)
    ? (m.review_type as ReviewType)
    : null;
  return {
    mode: m.mode,
    review_type: m.mode === 'review' ? type : null,
    started_at: m.started_at,
    exit_code: m.exit_code,
    has_output: m.has_output === true,
    idle_killed: m.idle_killed === true,
    validation: typeof m.validation === 'string' ? m.validation : null,
  };
}

/** Which counter a call used. A review without a recorded type counts as a code review. */
export function callKind(meta: CallMeta): AttemptKind {
  if (meta.mode === 'impl') return 'impl';
  return reviewKind(meta.review_type ?? 'general');
}

/**
 * Why a call does NOT use up a round, or null when it does (规划/11 §2.5, owner decision
 * 2026-10-02): only a call that ended without output is taken back.
 */
export function uncountedReason(meta: CallMeta): UncountedCall['reason'] | null {
  if (meta.has_output) return null;
  if (meta.exit_code === 124) return meta.idle_killed ? 'inactivity-kill' : 'timeout';
  if (meta.exit_code === 11) return 'capacity';
  // Exit 10 with validation "not-run": the wrapper never got an answer to validate.
  if (meta.exit_code === 10 && meta.validation !== 'failed' && meta.validation !== 'ok') {
    return 'no-output';
  }
  return null;
}

export type SettleResult = {
  state: TaskState | null;
  kind: AttemptKind | null;
  /** True when the call uses up a round (nothing was taken back). */
  counted: boolean;
  /** True when this invocation changed the state file. */
  changed: boolean;
};

/**
 * Takes the pre-counted round back when the call ended without output. Idempotent: a call
 * (kind + started_at) is taken back at most once. Without a state file nothing happens.
 */
export function settleCall(id: string, meta: CallMeta, now: Date = new Date()): SettleResult {
  const kind = callKind(meta);
  const reason = uncountedReason(meta);
  const prev = readState(id);
  if (prev === null) return { state: null, kind, counted: reason === null, changed: false };
  if (reason === null) return { state: prev, kind, counted: true, changed: false };
  const seen = prev.uncounted_calls.some(
    (c) => c.kind === kind && c.started_at === meta.started_at,
  );
  if (seen) return { state: prev, kind, counted: false, changed: false };
  const next: TaskState = {
    ...prev,
    attempts: { ...prev.attempts, [kind]: Math.max(0, prev.attempts[kind] - 1) },
    uncounted_calls: [
      ...prev.uncounted_calls,
      { kind, started_at: meta.started_at, exit_code: meta.exit_code, reason },
    ],
    updated_at: now.toISOString(),
  };
  writeState(next);
  return { state: next, kind, counted: false, changed: true };
}

/** Finished call metas of a run directory: meta.<mode>.json and attempts/<n>/meta.json. */
export function runCallMetas(runDir: string): CallMeta[] {
  const files: string[] = [];
  for (const mode of ['impl', 'review']) files.push(join(runDir, `meta.${mode}.json`));
  const archive = join(runDir, 'attempts');
  if (existsSync(archive)) {
    for (const name of readdirSync(archive)) {
      if (/^[0-9]+$/.test(name)) files.push(join(archive, name, 'meta.json'));
    }
  }
  const metas = new Map<string, CallMeta>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const meta = parseCallMeta(readJsonFile(file));
    if (meta !== null) metas.set(`${meta.mode}:${meta.started_at}`, meta);
  }
  return [...metas.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** 规划/11 §2.5: runaway-loop breaker, every finished Codex call of the task counts. */
export const MAX_CALLS_PER_TASK = 10;
/** 规划/11 §2.5: this many calls of a task in a row without output stop the task. */
export const MAX_CONSECUTIVE_NO_OUTPUT = 3;

export type BreakerReason = { breaker: 'task_calls' | 'no_output'; message: string };

export type TaskCalls = {
  task: string;
  /** Finished Codex calls of the task, with or without output. */
  calls: number;
  /** Trailing calls without output; capacity errors are skipped. */
  consecutive_no_output: number;
  /** Open breakers; empty when one more call is allowed. */
  reasons: BreakerReason[];
};

/**
 * The failure breakers of one task, from its finished calls in <runs>/<id>/. They close as soon
 * as the next call would cross a limit: at 10 calls, at 3 consecutive calls without output.
 */
export function taskCalls(id: string): TaskCalls {
  const metas = runCallMetas(join(runsDir(), id));
  let consecutive = 0;
  for (let i = metas.length - 1; i >= 0; i -= 1) {
    const meta = metas[i];
    if (!meta) break;
    // "Without output" is what gives a round back (uncountedReason), capacity errors aside.
    const reason = uncountedReason(meta);
    if (reason === 'capacity') continue;
    if (reason === null) break;
    consecutive += 1;
  }
  const reasons: BreakerReason[] = [];
  if (metas.length >= MAX_CALLS_PER_TASK) {
    reasons.push({
      breaker: 'task_calls',
      message: `${id}: 已累计调用 Codex ${metas.length} 次，达到每任务上限 ${MAX_CALLS_PER_TASK} 次（防失控循环，规划/11 §2.5）；停止该任务并报告：拆小任务或标 blocked`,
    });
  }
  if (consecutive >= MAX_CONSECUTIVE_NO_OUTPUT) {
    reasons.push({
      breaker: 'no_output',
      message: `${id}: 连续 ${consecutive} 次调用没有产出（规划/11 §2.5）；停止该任务并报告`,
    });
  }
  return { task: id, calls: metas.length, consecutive_no_output: consecutive, reasons };
}

export type MigrateOptions = {
  /** Counter for counted review rounds that left no meta.json behind. */
  unattributedReview?: 'spec-test' | 'code';
  now?: Date;
  dryRun?: boolean;
};

/**
 * Converts a state file of the old shape `attempts: {impl, review}` (one shared review counter)
 * to the per-type counters, attributing every review round from the run's meta.json files:
 * its review type picks the counter, and a call that ended without output is moved to
 * `uncounted_calls`. Everything else in the file (state, last_error, …) is kept.
 */
export function migrateState(id: string, opts: MigrateOptions = {}): TaskState {
  const now = opts.now ?? new Date();
  const file = stateFile(id);
  if (!existsSync(file)) throw new CheckError(`${id}: no state file`);
  const raw = readJsonFile(file) as Record<string, unknown>;
  const old = raw.attempts as Record<string, unknown> | undefined;
  if (typeof old !== 'object' || old === null || !('review' in old)) {
    return readState(id) as TaskState; // already in the new shape (validated)
  }
  if (!isCount(old.impl) || !isCount(old.review)) {
    throw new CheckError(`${file}: old attempts.impl / attempts.review are not counts`);
  }
  const metas = runCallMetas(join(runsDir(), id));
  const uncounted: UncountedCall[] = [];
  const attempts: Record<AttemptKind, number> = { impl: old.impl, 'spec-test': 0, code: 0 };
  for (const meta of metas.filter((m) => m.mode === 'impl')) {
    const reason = uncountedReason(meta);
    if (reason === null) continue;
    attempts.impl = Math.max(0, attempts.impl - 1);
    uncounted.push({
      kind: 'impl',
      started_at: meta.started_at,
      exit_code: meta.exit_code,
      reason,
    });
  }
  const reviews = metas.filter((m) => m.mode === 'review');
  if (reviews.length > old.review) {
    throw new CheckError(
      `${id}: ${reviews.length} review calls on file but only ${old.review} counted; fix the state by hand`,
    );
  }
  for (const meta of reviews) {
    const kind = callKind(meta);
    const reason = uncountedReason(meta);
    if (reason === null) attempts[kind] += 1;
    else uncounted.push({ kind, started_at: meta.started_at, exit_code: meta.exit_code, reason });
  }
  const missing = old.review - reviews.length;
  if (missing > 0) {
    if (opts.unattributedReview === undefined) {
      throw new CheckError(
        `${id}: ${missing} counted review round(s) left no meta.json; say which counter they used with --unattributed-review spec-test|code`,
      );
    }
    attempts[opts.unattributedReview] += missing;
  }
  const next = parseState(
    { ...raw, attempts, uncounted_calls: uncounted, updated_at: now.toISOString() },
    file,
  );
  if (!opts.dryRun) writeState(next);
  return next;
}

export type ClaimOptions = { owner: string; renew?: boolean; now?: Date };

/**
 * Claims a task: `mkdir couli-runs/claims/<id>` succeeds for exactly one caller.
 * The claim carries a 20 minute lease; an expired lease may be taken over by
 * another session. `renew` extends the lease of the session that holds it.
 */
export function claimTask(id: string, opts: ClaimOptions): TaskState {
  const now = opts.now ?? new Date();
  const dir = claimDir(id);
  const who = { session: opts.owner, pid: process.pid };
  if (opts.renew) {
    if (!heartbeatLock(dir, who, now)) {
      throw new CheckError(`${id}: no claim held by ${opts.owner} to renew`);
    }
  } else {
    const res = acquireLock(dir, who, now);
    if (!res.acquired) {
      const holder = res.status.held ? (res.status.holder?.session ?? 'unknown') : 'unknown';
      throw new CheckError(`${id}: already claimed by ${holder}`);
    }
  }
  return updateState(
    id,
    { owner_session: opts.owner, lease_until: new Date(now.getTime() + LEASE_MS).toISOString() },
    now,
  );
}

/** Drops the claim. With `owner` only that session may release it. */
export function releaseTask(id: string, opts: { owner?: string; now?: Date } = {}): TaskState {
  const now = opts.now ?? new Date();
  const dir = claimDir(id);
  const status = lockStatus(dir, now);
  if (status.held) {
    const holder = status.holder?.session;
    if (opts.owner !== undefined && holder !== undefined && holder !== opts.owner) {
      throw new CheckError(`${id}: claim is held by ${holder}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return updateState(id, { owner_session: null, lease_until: null, pid: null }, now);
}

function parseNullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === 'none' ? null : value;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string' },
      'spec-commit': { type: 'string' },
      pid: { type: 'string' },
      'started-at': { type: 'string' },
      'last-error': { type: 'string' },
      owner: { type: 'string' },
      renew: { type: 'boolean', default: false },
      'review-type': { type: 'string' },
      meta: { type: 'string' },
      'unattributed-review': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const [cmd, rawId, extra] = positionals;
  const id = assertTaskId(rawId);
  const owner = values.owner ?? 'orchestrator';

  if (cmd === 'get') {
    const state = readState(id);
    if (!state) throw new CheckError(`${id}: no state file`);
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  if (cmd === 'set') {
    const patch: StatePatch = {};
    if (values.state !== undefined) {
      if (!(STATES as readonly string[]).includes(values.state)) {
        throw new UsageError(`--state must be one of ${STATES.join(', ')}`);
      }
      patch.state = values.state as StateName;
    }
    const spec = parseNullable(values['spec-commit']);
    if (spec !== undefined) {
      if (spec !== null && !/^[0-9a-f]{7,40}$/.test(spec)) {
        throw new UsageError('--spec-commit must be a commit id or "none"');
      }
      patch.spec_commit = spec;
    }
    const pid = parseNullable(values.pid);
    if (pid !== undefined) {
      if (pid !== null && !/^[1-9][0-9]*$/.test(pid)) {
        throw new UsageError('--pid must be a positive integer or "none"');
      }
      patch.pid = pid === null ? null : Number.parseInt(pid, 10);
    }
    if (values['started-at'] !== undefined) {
      if (Number.isNaN(Date.parse(values['started-at']))) {
        throw new UsageError('--started-at must be an ISO-8601 instant');
      }
      patch.started_at = values['started-at'];
    }
    const lastError = parseNullable(values['last-error']);
    if (lastError !== undefined) patch.last_error = lastError;
    if (Object.keys(patch).length === 0) throw new UsageError('set needs at least one field');
    console.log(JSON.stringify(updateState(id, patch), null, 2));
    return 0;
  }
  if (cmd === 'claim') {
    console.log(JSON.stringify(claimTask(id, { owner, renew: values.renew }), null, 2));
    return 0;
  }
  if (cmd === 'release') {
    const opts = values.owner === undefined ? {} : { owner: values.owner };
    console.log(JSON.stringify(releaseTask(id, opts), null, 2));
    return 0;
  }
  if (cmd === 'bump-attempt') {
    let kind: AttemptKind;
    if (extra === 'impl') {
      if (values['review-type'] !== undefined) {
        throw new UsageError('--review-type applies to review only');
      }
      kind = 'impl';
    } else if (extra === 'review') {
      const type = values['review-type'];
      if (type === undefined || !(REVIEW_TYPES as readonly string[]).includes(type)) {
        throw new UsageError(
          `bump-attempt <id> review needs --review-type ${REVIEW_TYPES.join('|')} (each review type has its own rounds, 规划/11 §2.5)`,
        );
      }
      kind = reviewKind(type as ReviewType);
    } else {
      throw new UsageError(
        'bump-attempt <id> impl | bump-attempt <id> review --review-type <type>',
      );
    }
    const state = bumpAttempt(id, kind);
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  if (cmd === 'settle') {
    if (values.meta === undefined) throw new UsageError('settle <id> --meta <meta.json>');
    const meta = parseCallMeta(readJsonFile(values.meta));
    if (meta === null) throw new UsageError(`${values.meta}: not the meta.json of a finished call`);
    const res = settleCall(id, meta);
    console.log(
      JSON.stringify({
        task: id,
        kind: res.kind,
        counted: res.counted,
        changed: res.changed,
        attempts: res.state?.attempts ?? null,
      }),
    );
    return 0;
  }
  if (cmd === 'migrate') {
    const un = values['unattributed-review'];
    if (un !== undefined && un !== 'spec-test' && un !== 'code') {
      throw new UsageError('--unattributed-review must be spec-test or code');
    }
    const opts: MigrateOptions = { dryRun: values['dry-run'] };
    if (un !== undefined) opts.unattributedReview = un;
    console.log(JSON.stringify(migrateState(id, opts), null, 2));
    return 0;
  }
  throw new UsageError('expected: get|set|claim|release|bump-attempt|settle|migrate <id> ...');
}

if (import.meta.main) runMain(main);

// In-flight task state (规划/11 §2.1, §2.2, §2.5; planning docs/templates/task-ledger.md §3).
// Lives outside the repository in couli-runs/state/<id>.json; never committed.
//
//   node tools/ops/state.ts get <id>
//   node tools/ops/state.ts set <id> [--state <s>] [--spec-commit <sha>|none] [--pid <n>|none]
//                                    [--started-at <iso>] [--last-error <path>|none]
//   node tools/ops/state.ts claim <id> [--owner <session>] [--renew]
//   node tools/ops/state.ts release <id> [--owner <session>]
//   node tools/ops/state.ts bump-attempt <id> impl|review
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readJsonFile, writeFileAtomic } from '../lib/fsx.ts';
import { runsDir } from '../lib/paths.ts';
import { assertTaskId, CheckError, runMain, UsageError } from './cli.ts';
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

export type AttemptKind = 'impl' | 'review';

/** 规划/11 §2.5: at most 3 implementation attempts and 2 review rounds. */
export const ATTEMPT_LIMITS: Record<AttemptKind, number> = { impl: 3, review: 2 };

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
    attempts: { impl: 0, review: 0 },
    spec_commit: null,
    pid: null,
    started_at: null,
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
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
  if (!isCount(attempts?.impl) || !isCount(attempts?.review)) {
    bad('attempts.impl and attempts.review must be non-negative integers');
  }
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
  Omit<TaskState, 'id' | 'attempts' | 'updated_at' | 'ask_created_at'>
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
 * without a trace is still counted. Past the limit nothing is written.
 */
export function bumpAttempt(id: string, kind: AttemptKind, now: Date = new Date()): TaskState {
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
    if (extra !== 'impl' && extra !== 'review') {
      throw new UsageError('bump-attempt <id> impl|review');
    }
    const state = bumpAttempt(id, extra);
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  throw new UsageError('expected: get|set|claim|release|bump-attempt <id> ...');
}

if (import.meta.main) runMain(main);

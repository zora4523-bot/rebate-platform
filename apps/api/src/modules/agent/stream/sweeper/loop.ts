// Agent sweeper worker loop (B3-03h; design couli-runs/B3-03g/design.md v5 §5.3 「worker 内循环 +
// advisory lock」, §5.1, §7.4 B3-03h, §10.1 T10; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」: without a
// new request a worker finalizes left-over runs, a crash does not change the result; BR-AI-15 退还).
// Rule tests: test/spec/agent/stream-recovery/** import this file by path: names, signatures and
// the semantics written here are the contract. The pass itself (discovery, cursor, finalize calls)
// is B3-03e's createSweeper (./index.ts); this file only schedules it, once per tick, under one
// cluster-wide advisory lock.
//
// agentSweepLoopDefaults(): {intervalMs 60 000, jitterRatio 0.1, tickTimeoutMs 60 000,
//   stopTimeoutMs: a positive safe integer} (T10: period 60 s ± 10 %, one tick at most 60 s).
//   Constants come from this function only; nothing reads process.env.
// startAgentSweeper(deps) → {stop()}; throws RangeError unless intervalMs, tickTimeoutMs and
//   stopTimeoutMs are safe integers ≥ 1 and 0 ≤ jitterRatio < 1. Nothing runs synchronously.
//   Timers go only through deps.schedule (default: setTimeout, unref'd, cancel = clearTimeout),
//   each call naming its purpose; the current instant only through deps.clock.
//   - Period: start arms one 'tick' timer with delay round(intervalMs × (1 + jitterRatio × (2r −
//     1))), r = deps.random() (default Math.random) drawn per delay, so every delay lies in
//     [intervalMs × (1 − jitterRatio), intervalMs × (1 + jitterRatio)]. When a 'tick' timer fires
//     (and the loop is not stopped) it first arms the next 'tick' timer, then runs a tick; the
//     promise returned to the timer resolves when that tick is over (never rejects).
//   - running: a tick fired while another tick of this loop is still running does not run: info
//     or debug 'agent_sweep_skipped' {reason: 'busy'} and nothing else (no connection, no lock).
//   - A tick: db.connection().execute(c => …) — one pinned connection c for the whole tick; on c
//     `SELECT pg_try_advisory_lock(hashtextextended('agent.sweep', 0))`. false → info or debug
//     'agent_sweep_skipped' {reason: 'locked'}, the tick ends (sweepOnce not called). true →
//     sweeper.sweepOnce(cursor) (cursor kept in this process: sweepStart() at first, then the
//     nextCursor of the last pass that resolved), raced against a 'tick_timeout' timer of
//     tickTimeoutMs; then, in every case, `SELECT pg_advisory_unlock(hashtextextended('agent.sweep',
//     0))` on the same c before c goes back to the pool. Outcomes, one log line each:
//       resolved → cursor = nextCursor; info 'agent_sweep_tick' {processed, finalized,
//         skipped_running, skipped_held, failed, wrapped, duration_ms} (duration from deps.clock);
//       rejected → error 'agent_sweep_failed' {error_name}; cursor unchanged;
//       time limit first → warn 'agent_sweep_timeout' {timeout_ms}; the pass is abandoned (its
//         later result or rejection is ignored, never unhandled), the lock is released, cursor
//         unchanged;
//       c fails (lock query, unlock or the connection itself, e.g. its backend terminated) →
//         error 'agent_sweep_lock_failed' {error_name}; the tick ends. A backend that dies
//         releases its advisory lock in PostgreSQL, so another worker takes over next tick.
//     Log lines carry counts and error names only (never error messages: they may hold user
//     text). Whatever happens, the next 'tick' timer still fires as usual.
//   - stop(): idempotent (every call resolves; later calls do nothing more). Cancels the armed
//     'tick' timer; a 'tick' timer that still fires afterwards does nothing; if a tick is
//     running, resolves when it is over or when a 'stop_timeout' timer of stopTimeoutMs fires,
//     whichever comes first. After stop() no tick starts.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock and
// the injected schedule, data access only through Kysely on deps.db (the lock statements only).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type { Sweeper } from './index.ts';

export interface AgentSweepLoopConfig {
  /** Mean period between two ticks (T10: 60 s). */
  readonly intervalMs: number;
  /** Uniform jitter of each period, as a ratio of intervalMs (T10: 0.1). */
  readonly jitterRatio: number;
  /** Time limit of one tick (T10: 60 s). */
  readonly tickTimeoutMs: number;
  /** Upper bound of stop() waiting for a running tick. */
  readonly stopTimeoutMs: number;
}

/** Why the loop asks for a timer. */
export type AgentSweepTimer = 'tick' | 'tick_timeout' | 'stop_timeout';

export interface AgentSweepTimerHandle {
  /** Prevents a call not yet made; harmless after the call. */
  cancel(): void;
}

/**
 * Calls `run` once after `delayMs`. The promise `run` returns resolves when the work started by
 * that call is over (a tick: the end of the tick) and never rejects.
 */
export type AgentSweepSchedule = (
  run: () => Promise<void>,
  delayMs: number,
  timer: AgentSweepTimer,
) => AgentSweepTimerHandle;

export interface AgentSweepLoopDeps {
  readonly sweeper: Sweeper;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly config: AgentSweepLoopConfig;
  /** Default: setTimeout (unref'd). */
  readonly schedule?: AgentSweepSchedule;
  /** Jitter source in [0, 1); default Math.random. */
  readonly random?: () => number;
}

export interface AgentSweepLoop {
  stop(): Promise<void>;
}

export function agentSweepLoopDefaults(): AgentSweepLoopConfig {
  throw new Error('NotImplemented: agentSweepLoopDefaults (B3-03h)');
}

export function startAgentSweeper(deps: AgentSweepLoopDeps): AgentSweepLoop {
  void deps;
  throw new Error('NotImplemented: startAgentSweeper (B3-03h)');
}

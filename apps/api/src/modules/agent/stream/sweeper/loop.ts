// Agent sweeper worker loop (B3-03h; design couli-runs/B3-03g/design.md v5 §5.3 「worker 内循环 +
// advisory lock」, §5.1, §7.4 B3-03h, §10.1 T10; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」: without a
// new request a worker finalizes left-over runs, a crash does not change the result; BR-AI-15 退还).
// Rule tests: test/spec/agent/stream-recovery/** import this file by path: names, signatures and
// the semantics written here are the contract. Discovery, the cursor order and each finalize call
// are B3-03e's createSweeper (./index.ts). A B3-03e pass cannot be interrupted once started, so the
// loop never runs one big pass: deps.step is a sweeper that handles at most ONE row per call
// (createSweeper with config {...sweeperDefaults(), maxPerTick: 1}), and a tick calls it again and
// again under one cluster-wide advisory lock, checking before every call whether it may go on.
//
// agentSweepLoopDefaults(): {intervalMs 60 000, jitterRatio 0.1, tickTimeoutMs 60 000, maxPerTick
//   500 (= sweeperDefaults().maxPerTick), stopTimeoutMs: a positive safe integer} (T10: period
//   60 s ± 10 %, one tick at most 60 s and 500 rows). A fresh object per call; nothing reads
//   process.env.
// startAgentSweeper(deps) → {stop()}; throws RangeError unless intervalMs, tickTimeoutMs,
//   maxPerTick and stopTimeoutMs are safe integers ≥ 1 and 0 ≤ jitterRatio < 1 (nothing armed
//   then). Nothing runs synchronously but arming the first 'tick' timer. Timers go only through
//   deps.schedule (default: setTimeout, unref'd, cancel = clearTimeout), each call naming its
//   purpose; the current instant only through deps.clock.
//   - Period: start arms one 'tick' timer with delay round(intervalMs × (1 + jitterRatio × (2r −
//     1))), r = deps.random() (default Math.random) drawn once per 'tick' delay (no other timer
//     draws), so every delay lies in [intervalMs × (1 − jitterRatio), intervalMs × (1 +
//     jitterRatio)]. When a 'tick' timer fires (and the loop is not stopped) it first arms the
//     next 'tick' timer, then runs a tick; the promise returned to the timer resolves when that
//     tick is over (never rejects).
//   - running: a tick fired while another tick of this loop is still running does not run: info
//     or debug 'agent_sweep_skipped' {reason: 'busy'} and nothing else (no connection, no lock).
//     A tick that ended on its time-limit timer is over (see below) even if its last step is
//     still in flight.
//   - A tick: db.connection().execute(c => …) — one pinned connection c for the whole tick; on c
//     `SELECT pg_try_advisory_lock(hashtextextended('agent.sweep', 0))`. false → info or debug
//     'agent_sweep_skipped' {reason: 'locked'}; the tick ends, step never called. The lock query
//     failing → error 'agent_sweep_lock_failed' {error_name}; the tick ends. true → t0 =
//     deps.clock.now(); a 'tick_timeout' timer of tickTimeoutMs is armed; then the dispatch loop:
//       before EVERY step call, in this order: (1) stop() was called → end; (2) rows handled in
//       this tick (sum of the steps' processed) ≥ maxPerTick → end; (3) deps.clock.now() − t0 ≥
//       tickTimeoutMs → warn 'agent_sweep_tick_timeout' {timeout_ms, processed}, end; (4)
//       `SELECT 1` on the same c fails → error 'agent_sweep_lock_lost' {error_name}, end without
//       unlocking (the backend is gone and PostgreSQL released its lock; another worker may hold
//       it now). Then step.sweepOnce(cursor): resolved → counts are added, cursor = nextCursor;
//       wrapped true ends the tick (the eligible rows are exhausted; the next tick starts from
//       sweepStart()); a rejection → error 'agent_sweep_failed' {error_name}, cursor unchanged,
//       end.
//       The 'tick_timeout' timer firing while a step is in flight ends the tick at once: warn
//       'agent_sweep_tick_timeout' {timeout_ms, processed}; that step is abandoned — the finalize
//       it runs is not interrupted (row locks and conditional writes make it idempotent), its
//       later result or rejection is ignored (never unhandled, cursor unchanged) and NOTHING more
//       is dispatched by this tick, ever.
//     Every end except lock lost: `SELECT pg_advisory_unlock(hashtextextended('agent.sweep', 0))`
//     on the same c, then c goes back to the pool (an unlock failure is only an error line
//     'agent_sweep_lock_failed' {error_name}). The armed 'tick_timeout' timer is cancelled when
//     the tick ends otherwise.
//     A tick that ended on (1), (2) or wrapped logs info 'agent_sweep_tick' {processed, finalized,
//     skipped_running, skipped_held, failed, wrapped, duration_ms} (sums over its steps; duration
//     = deps.clock.now() at the end − t0). Every tick logs exactly one of 'agent_sweep_skipped',
//     'agent_sweep_tick', 'agent_sweep_tick_timeout', 'agent_sweep_lock_lost', 'agent_sweep_failed'
//     or 'agent_sweep_lock_failed' (plus, at most, an unlock failure line).
//     The cursor is kept in this process across ticks: sweepStart() at first, then the nextCursor
//     of the last step that resolved in time.
//     Log lines carry counts and error names only (never error messages: they may hold user
//     text). Whatever happens, the next 'tick' timer still fires as usual.
//   - stop(): idempotent (every call resolves; later calls do nothing more). Cancels the armed
//     'tick' timer; a 'tick' timer that still fires afterwards does nothing; a running tick
//     dispatches no further step (check (1)) and unlocks after its current step; stop() resolves
//     when that tick is over or when a 'stop_timeout' timer of stopTimeoutMs fires, whichever
//     comes first. After stop() no tick starts.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock and
// the injected schedule, data access only through Kysely on deps.db (the lock statements and the
// `SELECT 1` check only).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type { Sweeper } from './index.ts';

export interface AgentSweepLoopConfig {
  /** Mean period between two ticks (T10: 60 s). */
  readonly intervalMs: number;
  /** Uniform jitter of each period, as a ratio of intervalMs (T10: 0.1). */
  readonly jitterRatio: number;
  /** Time limit of one tick, from the lock on (T10: 60 s). */
  readonly tickTimeoutMs: number;
  /** Rows one tick hands to its steps at most (T10: 500). */
  readonly maxPerTick: number;
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
  /** A sweeper handling at most one row per sweepOnce (createSweeper with maxPerTick 1). */
  readonly step: Sweeper;
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

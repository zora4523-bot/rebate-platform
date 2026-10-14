// Agent left-over run sweeper: discovery and one sweep pass (B3-03e; design
// couli-runs/B3-03g/design.md v5 §5.3, §5.1, §4.2 I12, §8, §10.1 T10; BR-AI-23 细则「受理记录与
// 收尾 · 谁来收尾」: without a new request a worker finalizes left-over runs; BR-AI-15 退还 / 归日).
// Rule tests: test/spec/agent/stream-sweeper/** import this file by path: names, signatures and the
// semantics written here are the contract. Scheduling, the advisory lock and the worker loop are
// B3-03h's (stream/sweeper/loop.ts), not this file's.
//
// createSweeper({db, finalizer, clock, config, logger?}) → {sweepOnce(cursor)}. createSweeper
//   throws RangeError unless config.marginMs is a safe integer ≥ 0 and pageSize / maxPerTick are
//   safe integers ≥ 1.
// sweepOnce(cursor) — one pass, starting strictly after `cursor`:
//   now = clock.now() read once for the pass (time only from the injected Clock); bound = now −
//   marginMs. Pages of the source query (design §5.3):
//     SELECT s.run_lock_expires_at, s.id, s.run_lock_run_id
//     FROM app.agent_sessions s JOIN app.agent_runs r ON r.app_id = s.app_id AND r.id = s.run_lock_run_id
//     WHERE s.run_lock_run_id IS NOT NULL AND s.run_lock_expires_at <= bound
//       AND r.finalize_hold IS NULL AND (s.run_lock_expires_at, s.id) > (cursor.lockExpiresAt, cursor.sessionId)
//     ORDER BY s.run_lock_expires_at, s.id LIMIT min(pageSize, maxPerTick − processed)
//   (cursor.lockExpiresAt null = '-infinity'). For each row, in that order and one at a time:
//   finalizer.finalize(run_lock_run_id) (its own transaction; the sweeper writes no table itself);
//   then the cursor becomes that row's (run_lock_expires_at, id) whatever the outcome: kind final →
//   finalized; running → skipped.running; held → skipped.held; a rejection (AdmissionUnavailableError
//   or any other error) → logged with the run id, failed, and the pass goes on with the next row.
//   The pass ends when processed reaches maxPerTick (nextCursor = the last row processed, wrapped
//   false) or when a page returns fewer rows than it asked for (nextCursor = sweepStart(), wrapped
//   true; an empty first page included). processed = finalize calls made = finalized +
//   skipped.running + skipped.held + failed.
// sweeperDefaults(): {marginMs 10 000, pageSize 100, maxPerTick 500} (design §10.1 T10).
// sweepStart(): {lockExpiresAt: null ('-infinity'), sessionId: '00000000-0000-0000-0000-000000000000'}.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock,
// data access only through Kysely on deps.db (read only).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type { Finalizer } from '../pg/index.ts';

export interface SweepCursor {
  /** run_lock_expires_at of the last row handled; null = '-infinity' (the start). */
  readonly lockExpiresAt: Date | null;
  /** agent_sessions.id of the last row handled. */
  readonly sessionId: string;
}

/** The cursor a pass starts from: frozen, the same object on every call. */
export function sweepStart(): SweepCursor {
  throw new Error('NotImplemented: B3-03e sweepStart');
}

export interface SweeperConfig {
  /** A lock counts as left over once run_lock_expires_at ≤ now − marginMs. */
  readonly marginMs: number;
  readonly pageSize: number;
  readonly maxPerTick: number;
}

export interface SweeperDeps {
  readonly db: Kysely<DB>;
  readonly finalizer: Finalizer;
  readonly clock: Clock;
  readonly config: SweeperConfig;
  readonly logger?: Pick<RootLogger, 'warn' | 'error'>;
}

export interface SweepResult {
  /** finalize calls made in this pass. */
  readonly processed: number;
  /** Calls that returned kind final (written by this call or already there). */
  readonly finalized: number;
  readonly skipped: { readonly running: number; readonly held: number };
  /** Calls that rejected (retried in a later pass). */
  readonly failed: number;
  /** Where the next pass starts. */
  readonly nextCursor: SweepCursor;
  /** The pass reached the end of the eligible rows (nextCursor = sweepStart()). */
  readonly wrapped: boolean;
}

export interface Sweeper {
  sweepOnce(cursor: SweepCursor): Promise<SweepResult>;
}

export function sweeperDefaults(): SweeperConfig {
  throw new Error('NotImplemented: B3-03e sweeperDefaults');
}

export function createSweeper(deps: SweeperDeps): Sweeper {
  void deps;
  throw new Error('NotImplemented: B3-03e createSweeper');
}

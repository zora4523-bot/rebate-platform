// Queue interruption drill (规划/05 QA-05「队列中断」; 规划/02 §11 同事务入队、至少一次投递、消费端去重,
// §14 PostgreSQL 主库行「各进程断线后自动重连 … 任务队列在库内」与 Redis 行「任务入队在 PG 的业务事务内，
// 不依赖 Redis；任务照常取走执行，不需要恢复后补投」, §18 领域事件一行; ADR-0001 §3; AGENTS.md 硬规则 4、5).
// Skeleton of task QA-05b: every function throws NotImplemented; the rule tests in
// test/spec/drills/queue/** import this file by path and fix the semantics below.
//
// Only the local stack (infra/local, `pnpm dev:stack`) or a test database is a valid target; never
// staging or prod. The drill touches only its own queue and effect table (executor.reset clears them).
// Real side effects (docker compose stop / kill of the worker, pg_terminate_backend, stopping Redis)
// live behind `DrillExecutor`; the rule tests drive runDrill with an in-memory executor stub.
//
// 1. assertLocalTarget(target): pgUrl protocol postgres: or postgresql:, redisUrl protocol redis:;
//    a URL that does not parse or has another protocol → DrillError('invalid_option'). Hostname
//    exactly 127.0.0.1, localhost or [::1] (case-insensitive) for both, else DrillError('not_local').
// 2. runDrill(options): validates options first (jobsBefore / jobsDuring integers 1..500, pollMs
//    integer 100..10 000, progressTimeoutMs and drainTimeoutMs integers pollMs..600 000; else
//    'invalid_option'), then assertLocalTarget; both reject before any executor call.
//    Steps, in this order (result.steps lists the steps that ran):
//      preflight                 executor.reset()
//      enqueue                   jobsBefore new ids (options.newId) in ONE executor.enqueue call
//      start_worker              executor.startWorker()
//      await_progress            poll executor.snapshot() every pollMs (options.sleep) until a sent
//                                job has effects ≥ 1 or progressTimeoutMs elapsed (options.clock)
//      interrupt                 worker-stop: stopWorker('graceful'); worker-kill: stopWorker('kill');
//                                queue-disconnect: disconnectQueue(); redis-down: stopRedis()
//      enqueue_during_outage     jobsDuring new ids in ONE executor.enqueue call
//      recover, drain            worker-stop / worker-kill: recover = startWorker(), then drain;
//                                queue-disconnect: recover makes no executor call (the worker must
//                                reconnect by itself), then drain;
//                                redis-down: drain FIRST (jobs must run while Redis is down), then
//                                recover = startRedis().
//                                drain polls snapshot() every pollMs until every sent id is in a
//                                terminal state (completed, failed, cancelled, absent) or
//                                drainTimeoutMs elapsed since the drain step began; a timeout is
//                                not an error, verify then reports not_drained.
//      verify                    a fresh snapshot() judged by judgeDrill
//      cleanup                   stopWorker('graceful') if the worker this drill started is still
//                                running; startRedis() if Redis is still stopped
//    No id is ever sent twice and nothing is re-sent after recovery (02 §14 Redis 行「不需要恢复后补投」).
//    An executor rejection in any step from preflight to verify ends the run there: problem
//    { code: 'step_failed', id: null, step }, then cleanup still runs; a cleanup rejection adds
//    { code: 'step_failed', id: null, step: 'cleanup' }. runDrill then resolves (the record is
//    still written). sent = the ids of the enqueue calls that resolved, in send order.
//    ok = problems is empty. startedAt / finishedAt are clock.now().toISOString() at start / end.
// 3. judgeDrill(sent, snapshot): for each sent id, in sent order: state created / retry / active →
//    not_drained only; otherwise effects 0 (or no view) → lost, effects > 1 → duplicate_effect, and
//    state failed → failed (in this order). Then each snapshot job whose id was not sent →
//    unexpected_job, ids in ascending code-unit order. redelivered = number of sent ids with
//    deliveries > 1 (at least once delivery is allowed; only a second business effect is a fault).
// 4. recordPath: <runsDir>/drills/queue/<scenario>-<YYYYMMDDTHHMMSSZ of startedAt, UTC>.json;
//    repoRoot and runsDir must be absolute ('invalid_option'); runsDir equal to or inside repoRoot
//    (after normalisation) → 'record_in_repo' (演练记录写运行目录，不入库).
// 5. parseDrillArgs: --scenario <one of the four> (required), --runs-dir <absolute> (required),
//    --jobs <integer 1..500> (default 20, used for both jobsBefore and jobsDuring); a missing,
//    repeated or unknown flag or a bad value → 'invalid_option'.

export type DrillScenario = 'worker-stop' | 'worker-kill' | 'queue-disconnect' | 'redis-down';

export type DrillStep =
  | 'preflight'
  | 'enqueue'
  | 'start_worker'
  | 'await_progress'
  | 'interrupt'
  | 'enqueue_during_outage'
  | 'recover'
  | 'drain'
  | 'verify'
  | 'cleanup';

export type DrillJobState =
  'created' | 'retry' | 'active' | 'completed' | 'failed' | 'cancelled' | 'absent';

/** One drill job: its queue state, handler calls so far and business effect rows written. */
export interface DrillJobView {
  readonly id: string;
  readonly state: DrillJobState;
  readonly deliveries: number;
  readonly effects: number;
}

export interface DrillSnapshot {
  readonly jobs: readonly DrillJobView[];
}

export interface DrillExecutor {
  reset(): Promise<void>;
  /** Same-transaction enqueue of one business row per id (job id = event id). */
  enqueue(ids: readonly string[]): Promise<void>;
  startWorker(): Promise<void>;
  stopWorker(mode: 'graceful' | 'kill'): Promise<void>;
  /** Terminates the worker's PostgreSQL connections; the worker must reconnect by itself. */
  disconnectQueue(): Promise<void>;
  stopRedis(): Promise<void>;
  startRedis(): Promise<void>;
  snapshot(): Promise<DrillSnapshot>;
}

export interface DrillClock {
  now(): Date;
}

export interface DrillTarget {
  readonly pgUrl: string;
  readonly redisUrl: string;
}

export interface DrillOptions {
  readonly scenario: DrillScenario;
  readonly target: DrillTarget;
  readonly executor: DrillExecutor;
  readonly clock: DrillClock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newId: () => string;
  readonly jobsBefore: number;
  readonly jobsDuring: number;
  readonly pollMs: number;
  readonly progressTimeoutMs: number;
  readonly drainTimeoutMs: number;
}

export type DrillProblemCode =
  'lost' | 'duplicate_effect' | 'failed' | 'not_drained' | 'unexpected_job' | 'step_failed';

export interface DrillProblem {
  readonly code: DrillProblemCode;
  readonly id: string | null;
  readonly step: DrillStep | null;
}

export interface DrillVerdict {
  readonly problems: readonly DrillProblem[];
  readonly redelivered: number;
}

export interface DrillResult extends DrillVerdict {
  readonly scenario: DrillScenario;
  readonly ok: boolean;
  readonly steps: readonly DrillStep[];
  readonly sent: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface DrillArgs {
  readonly scenario: DrillScenario;
  readonly runsDir: string;
  readonly jobs: number;
}

export type DrillErrorCode = 'not_local' | 'invalid_option' | 'record_in_repo';

export class DrillError extends Error {
  declare readonly code: DrillErrorCode;

  constructor(code: DrillErrorCode) {
    super();
    void code;
    throw new Error('NotImplemented: DrillError');
  }
}

export function assertLocalTarget(target: DrillTarget): void {
  void target;
  throw new Error('NotImplemented: assertLocalTarget');
}

export function judgeDrill(sent: readonly string[], snapshot: DrillSnapshot): DrillVerdict {
  void sent;
  void snapshot;
  throw new Error('NotImplemented: judgeDrill');
}

export async function runDrill(options: DrillOptions): Promise<DrillResult> {
  void options;
  throw new Error('NotImplemented: runDrill');
}

export function recordPath(options: {
  readonly repoRoot: string;
  readonly runsDir: string;
  readonly scenario: DrillScenario;
  readonly startedAt: Date;
}): string {
  void options;
  throw new Error('NotImplemented: recordPath');
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  void argv;
  throw new Error('NotImplemented: parseDrillArgs');
}

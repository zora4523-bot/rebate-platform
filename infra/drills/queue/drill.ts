// Queue interruption drill (规划/05 QA-05「队列中断」; 规划/02 §11 同事务入队、至少一次投递、消费端去重,
// §14 PostgreSQL 主库行「各进程断线后自动重连 … 任务队列在库内」与 Redis 行「任务入队在 PG 的业务事务内，
// 不依赖 Redis；任务照常取走执行，不需要恢复后补投」, §18 领域事件一行; ADR-0001 §3; AGENTS.md 硬规则 4、5).
// The rule tests in test/spec/drills/queue/** fix the semantics below.
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

import { isAbsolute, relative, resolve, sep } from 'node:path';

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
    super(code);
    this.name = 'DrillError';
    this.code = code;
  }
}

export function assertLocalTarget(target: DrillTarget): void {
  let pg: URL;
  let redis: URL;
  try {
    pg = new URL(target.pgUrl);
    redis = new URL(target.redisUrl);
  } catch {
    throw new DrillError('invalid_option');
  }
  if (!['postgres:', 'postgresql:'].includes(pg.protocol) || redis.protocol !== 'redis:') {
    throw new DrillError('invalid_option');
  }
  for (const url of [pg, redis]) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
      throw new DrillError('not_local');
    }
    // pg connection-string query parameters can override host, port and even credentials.
    // The drill needs none of them; never let them bypass the loopback check.
    if (url.search !== '' || url.hash !== '') throw new DrillError('invalid_option');
  }
}

export function judgeDrill(sent: readonly string[], snapshot: DrillSnapshot): DrillVerdict {
  const views = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const sentIds = new Set(sent);
  const problems: DrillProblem[] = [];
  let redelivered = 0;
  for (const id of sent) {
    const job = views.get(id);
    if (job !== undefined && job.deliveries > 1) redelivered += 1;
    if (job !== undefined && pending(job.state)) {
      problems.push({ code: 'not_drained', id, step: null });
      continue;
    }
    if (job === undefined || job.effects === 0) problems.push({ code: 'lost', id, step: null });
    if (job !== undefined && job.effects > 1) {
      problems.push({ code: 'duplicate_effect', id, step: null });
    }
    if (job?.state === 'failed') problems.push({ code: 'failed', id, step: null });
  }
  for (const id of [...views.keys()].filter((id) => !sentIds.has(id)).sort()) {
    problems.push({ code: 'unexpected_job', id, step: null });
  }
  return { problems, redelivered };
}

export async function runDrill(options: DrillOptions): Promise<DrillResult> {
  if (
    !isScenario(options.scenario) ||
    !integerBetween(options.jobsBefore, 1, 500) ||
    !integerBetween(options.jobsDuring, 1, 500) ||
    !integerBetween(options.pollMs, 100, 10_000) ||
    !integerBetween(options.progressTimeoutMs, options.pollMs, 600_000) ||
    !integerBetween(options.drainTimeoutMs, options.pollMs, 600_000)
  )
    throw new DrillError('invalid_option');
  assertLocalTarget(options.target);
  const { executor, clock, scenario } = options;
  const startedAt = clock.now().toISOString();
  const steps: DrillStep[] = [];
  const sent: string[] = [];
  const allocated = new Set<string>();
  const problems: DrillProblem[] = [];
  let redelivered = 0;
  let workerMayRun = false;
  let redisMayBeDown = false;
  let current: DrillStep = 'preflight';
  const step = async (name: DrillStep, action: () => Promise<void>) => {
    current = name;
    steps.push(name);
    await action();
  };
  const enqueue = async (count: number) => {
    const ids = Array.from({ length: count }, () => {
      const id = options.newId();
      if (typeof id !== 'string' || id.length === 0 || allocated.has(id)) {
        throw new DrillError('invalid_option');
      }
      allocated.add(id);
      return id;
    });
    await executor.enqueue(ids);
    sent.push(...ids);
  };
  const startWorker = async () => {
    workerMayRun = true; // also clean up a partially successful start
    await executor.startWorker();
  };
  const recover = async () => {
    if (scenario === 'worker-stop' || scenario === 'worker-kill') await startWorker();
    if (scenario === 'redis-down') {
      await executor.startRedis();
      redisMayBeDown = false;
    }
  };
  const poll = async (timeout: number, done: (snapshot: DrillSnapshot) => boolean) => {
    const begin = clock.now().getTime();
    // Budget also bounds waiting if the injected wall clock moves backwards or is frozen.
    let budget = timeout;
    for (;;) {
      const snapshot = await executor.snapshot();
      if (done(snapshot)) return { snapshot, timedOut: false };
      const remaining = Math.min(budget, timeout - (clock.now().getTime() - begin));
      if (remaining <= 0) return { snapshot, timedOut: true };
      const wait = Math.min(options.pollMs, remaining);
      await options.sleep(wait);
      budget -= wait;
    }
  };
  const drain = async () => {
    const last = await poll(options.drainTimeoutMs, (snapshot) => {
      const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
      return sent.every((id) => !pending(jobs.get(id)?.state ?? 'absent'));
    });
    // A recovery must never erase evidence that processing depended on Redis being up.
    if (scenario === 'redis-down' && last.timedOut) {
      problems.push(...judgeDrill(sent, last.snapshot).problems);
    }
  };
  try {
    await step('preflight', () => executor.reset());
    await step('enqueue', () => enqueue(options.jobsBefore));
    await step('start_worker', startWorker);
    await step('await_progress', async () => {
      const progress = await poll(options.progressTimeoutMs, (snapshot) =>
        snapshot.jobs.some((job) => sent.includes(job.id) && job.effects >= 1),
      );
      if (progress.timedOut) throw new Error('No consumer progress');
    });
    await step('interrupt', async () => {
      if (scenario === 'worker-stop' || scenario === 'worker-kill') {
        await executor.stopWorker(scenario === 'worker-stop' ? 'graceful' : 'kill');
        workerMayRun = false;
      } else if (scenario === 'queue-disconnect') {
        await executor.disconnectQueue();
      } else {
        redisMayBeDown = true;
        await executor.stopRedis();
      }
    });
    await step('enqueue_during_outage', () => enqueue(options.jobsDuring));
    if (scenario === 'redis-down') {
      await step('drain', drain);
      await step('recover', recover);
    } else {
      await step('recover', recover);
      await step('drain', drain);
    }
    await step('verify', async () => {
      const verdict = judgeDrill(sent, await executor.snapshot());
      redelivered = verdict.redelivered;
      for (const problem of verdict.problems) {
        if (!problems.some((p) => p.code === problem.code && p.id === problem.id)) {
          problems.push(problem);
        }
      }
    });
  } catch {
    // Do not persist raw driver errors: they may contain a database URL or credentials.
    problems.push({ code: 'step_failed', id: null, step: current });
  } finally {
    steps.push('cleanup');
    let cleanupFailed = false;
    if (workerMayRun) {
      try {
        await executor.stopWorker('graceful');
      } catch {
        cleanupFailed = true;
      }
    }
    if (redisMayBeDown) {
      try {
        await executor.startRedis();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) problems.push({ code: 'step_failed', id: null, step: 'cleanup' });
  }
  return {
    scenario,
    ok: problems.length === 0,
    problems,
    redelivered,
    steps,
    sent,
    startedAt,
    finishedAt: clock.now().toISOString(),
  };
}

export function recordPath(options: {
  readonly repoRoot: string;
  readonly runsDir: string;
  readonly scenario: DrillScenario;
  readonly startedAt: Date;
}): string {
  if (
    !isAbsolute(options.repoRoot) ||
    !isAbsolute(options.runsDir) ||
    !isScenario(options.scenario) ||
    !Number.isFinite(options.startedAt.getTime())
  ) {
    throw new DrillError('invalid_option');
  }
  const rel = relative(resolve(options.repoRoot), resolve(options.runsDir));
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new DrillError('record_in_repo');
  }
  const stamp = options.startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return resolve(options.runsDir, 'drills', 'queue', `${options.scenario}-${stamp}.json`);
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      flag === undefined ||
      !['--scenario', '--runs-dir', '--jobs'].includes(flag) ||
      values.has(flag) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new DrillError('invalid_option');
    }
    values.set(flag, value);
  }
  const scenario = values.get('--scenario');
  const runsDir = values.get('--runs-dir');
  const rawJobs = values.get('--jobs') ?? '20';
  const jobs = Number(rawJobs);
  if (
    !isScenario(scenario) ||
    runsDir === undefined ||
    !isAbsolute(runsDir) ||
    !/^\d+$/.test(rawJobs) ||
    !integerBetween(jobs, 1, 500)
  ) {
    throw new DrillError('invalid_option');
  }
  return { scenario, runsDir, jobs };
}

function isScenario(value: unknown): value is DrillScenario {
  return (
    value === 'worker-stop' ||
    value === 'worker-kill' ||
    value === 'queue-disconnect' ||
    value === 'redis-down'
  );
}

function integerBetween(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pending(state: DrillJobState): boolean {
  return state === 'created' || state === 'active' || state === 'retry';
}

// In-memory stand-in for the local stack of the queue drill (no container, no database, no network).
// It models at least once delivery: a worker kill leaves the in-flight job with its business effect
// committed but its completion lost, so the job is delivered again; `dedup` is the consumer's
// processed_events check (规划/02 §11、§18).
import type {
  DrillExecutor,
  DrillJobState,
  DrillOptions,
  DrillSnapshot,
} from '../../../../infra/drills/queue/drill.ts';

export interface StubBehaviour {
  /** Consumer dedups by job id (processed_events) — the correct system. */
  dedup: boolean;
  /** The kill drops the in-flight job altogether (a lost job). */
  loseOnKill: boolean;
  /** Jobs stop running while Redis is down (a wrong dependency on Redis). */
  workNeedsRedis: boolean;
  /** Enqueue fails while Redis is down (a wrong dependency on Redis). */
  enqueueNeedsRedis: boolean;
  /** After disconnectQueue the worker reconnects after this many polls; null = never. */
  reconnectAfterPolls: number | null;
  /** Jobs a running worker finishes per snapshot poll. */
  perPoll: number;
}

interface Job {
  state: DrillJobState;
  deliveries: number;
  effects: number;
}

export interface Stub extends DrillExecutor {
  readonly calls: string[];
  readonly jobs: Map<string, Job>;
}

export function makeStub(overrides: Partial<StubBehaviour> = {}): Stub {
  const b: StubBehaviour = {
    dedup: true,
    loseOnKill: false,
    workNeedsRedis: false,
    enqueueNeedsRedis: false,
    reconnectAfterPolls: 2,
    perPoll: 2,
    ...overrides,
  };
  const calls: string[] = [];
  const jobs = new Map<string, Job>();
  const processed = new Set<string>();
  let worker = false;
  let redis = true;
  let disconnectedPolls: number | null = null;

  const deliver = (id: string, job: Job, complete: boolean): void => {
    job.deliveries += 1;
    if (!(b.dedup && processed.has(id))) {
      job.effects += 1;
      processed.add(id);
    }
    if (complete) job.state = 'completed';
  };

  const work = (): void => {
    if (!worker) return;
    if (disconnectedPolls !== null) {
      if (b.reconnectAfterPolls === null || disconnectedPolls < b.reconnectAfterPolls) {
        disconnectedPolls += 1;
        return;
      }
      disconnectedPolls = null;
    }
    if (b.workNeedsRedis && !redis) return;
    let done = 0;
    for (const [id, job] of jobs) {
      if (done >= b.perPoll) break;
      if (job.state !== 'created') continue;
      deliver(id, job, true);
      done += 1;
    }
  };

  return {
    calls,
    jobs,
    async reset() {
      calls.push('reset');
      jobs.clear();
      processed.clear();
    },
    async enqueue(ids) {
      calls.push(`enqueue:${ids.length}`);
      if (b.enqueueNeedsRedis && !redis) throw new Error('drill stub: enqueue refused');
      for (const id of ids) jobs.set(id, { state: 'created', deliveries: 0, effects: 0 });
    },
    async startWorker() {
      calls.push('startWorker');
      worker = true;
    },
    async stopWorker(mode) {
      calls.push(`stopWorker:${mode}`);
      if (mode === 'kill') {
        const inFlight = [...jobs].find(([, job]) => job.state === 'created');
        if (inFlight !== undefined) {
          const [id, job] = inFlight;
          if (b.loseOnKill) job.state = 'absent';
          else deliver(id, job, false);
        }
      }
      worker = false;
    },
    async disconnectQueue() {
      calls.push('disconnectQueue');
      disconnectedPolls = 0;
    },
    async stopRedis() {
      calls.push('stopRedis');
      redis = false;
    },
    async startRedis() {
      calls.push('startRedis');
      redis = true;
    },
    async snapshot(): Promise<DrillSnapshot> {
      calls.push('snapshot');
      work();
      return { jobs: [...jobs].map(([id, job]) => ({ id, ...job })) };
    },
  };
}

/** The executor calls without the polls, to compare step order. */
export function actions(stub: Stub): string[] {
  return stub.calls.filter((call) => call !== 'snapshot');
}

export interface FakeTime {
  sleeps: number;
  readonly options: Pick<DrillOptions, 'clock' | 'sleep' | 'newId'>;
}

/** Injected clock, sleep and id source: sleep advances the clock, nothing waits for real. */
export function fakeTime(): FakeTime {
  let nowMs = Date.UTC(2026, 9, 6, 1, 2, 3);
  let seq = 0;
  const time: FakeTime = {
    sleeps: 0,
    options: {
      clock: { now: () => new Date(nowMs) },
      sleep: async (ms) => {
        time.sleeps += 1;
        nowMs += ms;
      },
      newId: () => {
        seq += 1;
        return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      },
    },
  };
  return time;
}

export const LOCAL = {
  pgUrl: 'postgres://couli_app@127.0.0.1:54329/couli',
  redisUrl: 'redis://127.0.0.1:63790',
} as const;

export function drillOptions(
  stub: Stub,
  time: FakeTime,
  overrides: Partial<DrillOptions> = {},
): DrillOptions {
  return {
    scenario: 'worker-stop',
    target: LOCAL,
    executor: stub,
    ...time.options,
    jobsBefore: 4,
    jobsDuring: 3,
    pollMs: 1_000,
    progressTimeoutMs: 10_000,
    drainTimeoutMs: 30_000,
    ...overrides,
  };
}

// Shared helpers of the platform/queue rule tests (ADR-0001 §2 队列与事件, §3, §4.2 第 14、19 项;
// 规划/02 §11, §18; contract in apps/api/src/modules/platform/queue/index.ts). Expected values are
// written out by hand from the contract, never taken from the implementation.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may.
import {
  QueueError,
  type EntryPlan,
  type QueueErrorCode,
  type QueueSpec,
  type WorkSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';

export const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
export type Entry = (typeof ENTRIES)[number];

/** Fixed messages of section 8, copied by hand. */
export const MESSAGES: Readonly<Record<QueueErrorCode, string>> = {
  invalid_catalog: 'the queue catalog or the entry plan is invalid',
  invalid_option: 'invalid job queue option',
  unknown_queue: 'the queue is not in the catalog',
  invalid_name: 'invalid job name',
  invalid_payload: 'the job payload must be a plain JSON object',
  payload_too_large: 'the job payload exceeds 16384 bytes',
  not_in_entry: 'this entry does not work the queue',
  duplicate_handler: 'a handler is already registered for the queue',
  already_started: 'the job queue has already been started',
  not_running: 'the job queue is not running',
  schema_mismatch: 'the pg-boss schema version of the database is not 42',
  queue_mismatch:
    'a queue in the database has another policy or dead letter queue than the catalog',
};

/** A queue spec with the given name and overrides; defaults are small values for fast tests. */
export function spec(name: string, overrides: Partial<QueueSpec> = {}): QueueSpec {
  return {
    name,
    policy: 'standard',
    retryLimit: 2,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 60,
    retentionSeconds: 3600,
    deleteAfterSeconds: 3600,
    deadLetter: 'test-dead',
    ...overrides,
  };
}

/** The dead letter queue of the test catalogs. */
export const TEST_DEAD: QueueSpec = spec('test-dead', {
  retryLimit: 0,
  deadLetter: null,
});

/**
 * Test catalog: `t-std` (standard, 2 retries of 1 s), `t-excl` (exclusive, 1 retry after 60 s so a
 * failed job stays in `retry`), `t-excl2` (exclusive, no retry), `t-once` (standard, no retry), `t-wide`
 * (standard, worked with concurrency 3), `t-pay` (payout entry, concurrency 1) and `test-dead`.
 */
export const TEST_CATALOG: readonly QueueSpec[] = [
  spec('t-std'),
  spec('t-excl', { policy: 'exclusive', retryLimit: 1, retryDelaySeconds: 60 }),
  spec('t-excl2', { policy: 'exclusive', retryLimit: 0 }),
  spec('t-once', { retryLimit: 0 }),
  spec('t-wide'),
  spec('t-pay', { policy: 'exclusive' }),
  TEST_DEAD,
];

function work(queue: string, concurrency: number): WorkSpec {
  return { queue, concurrency, pollingIntervalSeconds: 0.5 };
}

export const TEST_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: [
    work('t-std', 1),
    work('t-excl', 1),
    work('t-excl2', 1),
    work('t-once', 1),
    work('t-wide', 3),
  ],
  payout: [work('t-pay', 1)],
};

export function describeError(error: unknown): string {
  if (error instanceof QueueError) return `QueueError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** How a synchronous call ended: `returned` or describeError of what it threw. */
export function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return describeError(error);
  }
  return 'returned';
}

/** How a promise settled: `resolved`, or describeError of the reason. */
export async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return describeError(error);
  }
  return 'resolved';
}

/** Runs `scenario`; an error it throws becomes `{ error: describeError(…) }`. */
export async function observe<T>(scenario: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await scenario();
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** One V8 stack frame: `    at [async ][function (]location[)]`. */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly a QueueError of `code` (section 8): name, code, fixed message, a stack
 * of that message and plain frames, own properties exactly code / message / name / stack, no cause.
 */
export function queueErrorProblems(error: unknown, code: QueueErrorCode): string[] {
  if (!(error instanceof QueueError)) return [`not a QueueError: ${describeError(error)}`];
  const found: string[] = [];
  const message = MESSAGES[code];
  if (error.name !== 'QueueError') found.push('name');
  if (error.code !== code) found.push(`code ${String(error.code)}`);
  if (error.message !== message) found.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `QueueError: ${message}`) found.push('stack head');
  if (frames.length === 0 || frames.some((frame) => !FRAME.test(frame))) found.push('stack frames');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['code', 'message', 'name', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** The error a synchronous call threw, checked with queueErrorProblems; ['returned'] otherwise. */
export function thrownProblems(run: () => unknown, code: QueueErrorCode): string[] {
  try {
    run();
  } catch (error) {
    return queueErrorProblems(error, code);
  }
  return ['returned'];
}

/** The rejection of `promise` checked with queueErrorProblems; ['resolved'] when it resolved. */
export async function rejectionProblems(
  promise: Promise<unknown>,
  code: QueueErrorCode,
): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return queueErrorProblems(error, code);
  }
  return ['resolved'];
}

/** A root logger of `entry` at level trace that writes its raw JSON lines into `lines`. */
export function memoryLogger(entry: Entry): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry, appEnv: 'test' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A raw log line checked and reduced: one JSON object with no key twice (its re-serialisation
 * equals the raw line), an ISO `time` and `pid` equal to this process. Returns the record without
 * `time` and `pid`, or a string saying what is wrong.
 */
export function reduceLine(raw: string): Record<string, unknown> | string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return `not JSON: ${raw}`;
  }
  if (`${JSON.stringify(record)}\n` !== raw) return `not one plain JSON line: ${raw}`;
  const { time, pid, ...rest } = record;
  if (typeof time !== 'string' || !ISO_TIME.test(time)) return `time: ${String(time)}`;
  if (pid !== process.pid) return `pid: ${String(pid)}`;
  return rest;
}

const LEVELS = { warn: 40, error: 50 } as const;

/** The expected reduced line (see reduceLine) of a logger of `memoryLogger(entry)`. */
export function line(
  entry: Entry,
  level: keyof typeof LEVELS,
  fields: Record<string, unknown>,
  msg: string,
): Record<string, unknown> {
  return { level: LEVELS[level], entry, env: 'test', ...fields, msg };
}

/** Promise that resolves after `ms`. */
export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls `ready` every 50 ms until it is true, for at most `limitMs`; returns whether it got true. */
export async function waitFor(
  ready: () => boolean | Promise<boolean>,
  limitMs: number,
): Promise<boolean> {
  const stop = performance.now() + limitMs;
  for (;;) {
    if (await ready()) return true;
    if (performance.now() > stop) return false;
    await sleep(50);
  }
}

/** A gate a handler can wait on; `open()` lets every waiter through. */
export function gate(): { wait: () => Promise<void>; open: () => void } {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => opened, open: () => release() };
}

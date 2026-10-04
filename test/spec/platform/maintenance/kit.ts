// Shared helpers of the platform/maintenance rule tests (B1-01j; contract in
// apps/api/src/modules/platform/maintenance/index.ts). Expected values are written out by hand from
// the contract, never taken from the implementation. Nothing here imports the test-database base
// (`@couli/db/testing`): only *.int.test.ts may.
import {
  MaintenanceError,
  createPartitionMaintenance,
  type MaintenanceErrorCode,
  type PartitionMaintenance,
  type PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';

/** Fixed messages of section G, copied by hand. */
export const MESSAGES: Readonly<Record<MaintenanceErrorCode, string>> = {
  invalid_option: 'invalid partition maintenance option',
  wrong_role: 'partition maintenance must run as couli_maint',
  already_started: 'partition maintenance has already been started',
};

export function describeError(error: unknown): string {
  if (error instanceof MaintenanceError) return `MaintenanceError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** One V8 stack frame: `    at [async ][function (]location[)]`. */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly a MaintenanceError of `code` (section G): name, code, fixed message, a
 * stack of that message and plain frames, own properties exactly code / message / name / stack, no
 * cause.
 */
export function errorProblems(error: unknown, code: MaintenanceErrorCode): string[] {
  if (!(error instanceof MaintenanceError))
    return [`not a MaintenanceError: ${describeError(error)}`];
  const found: string[] = [];
  const message = MESSAGES[code];
  if (error.name !== 'MaintenanceError') found.push('name');
  if (error.code !== code) found.push(`code ${String(error.code)}`);
  if (error.message !== message) found.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `MaintenanceError: ${message}`) found.push('stack head');
  if (frames.length === 0 || frames.some((frame) => !FRAME.test(frame))) found.push('stack frames');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['code', 'message', 'name', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** The error a synchronous call threw, checked with errorProblems; ['returned'] otherwise. */
export function thrownProblems(run: () => unknown, code: MaintenanceErrorCode): string[] {
  try {
    run();
  } catch (error) {
    return errorProblems(error, code);
  }
  return ['returned'];
}

/** The rejection of `promise` checked with errorProblems; ['resolved'] when it resolved. */
export async function rejectionProblems(
  promise: Promise<unknown>,
  code: MaintenanceErrorCode,
): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return errorProblems(error, code);
  }
  return ['resolved'];
}

/** A root logger of the worker entry at level trace that writes its raw JSON lines into `lines`. */
export function memoryLogger(): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
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

const LEVELS = { info: 30, warn: 40, error: 50 } as const;

/** The expected reduced line (see reduceLine) of a logger of `memoryLogger()`. */
export function line(
  level: keyof typeof LEVELS,
  msg: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { level: LEVELS[level], entry: 'worker', env: 'test', ...fields, msg };
}

/** The `partition_maintenance_done` line with these counts. */
export function done(ensured: number, dropped: number, failed: number): Record<string, unknown> {
  return line('info', 'partition_maintenance_done', { ensured, dropped, failed });
}

/** Promise that resolves after `ms`. */
export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls `ready` every 20 ms until it is true, for at most `limitMs`; returns whether it got true. */
export async function waitFor(
  ready: () => boolean | Promise<boolean>,
  limitMs: number,
): Promise<boolean> {
  const stop = performance.now() + limitMs;
  for (;;) {
    if (await ready()) return true;
    if (performance.now() > stop) return false;
    await sleep(20);
  }
}

/** A clock that returns `instant` and counts its calls. */
export function countingClock(instant: string): { now: () => Date; calls: () => number } {
  let calls = 0;
  const epoch = new Date(instant).getTime();
  return {
    now: () => {
      calls += 1;
      return new Date(epoch);
    },
    calls: () => calls,
  };
}

/** 'YYYY-MM' of every month from `first` to `last`, inclusive. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  const end = Number(last.slice(0, 4)) * 12 + Number(last.slice(5, 7));
  while (year * 12 + month <= end) {
    out.push(`${String(year)}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** `<table>_pYYYYMM` for each 'YYYY-MM'. */
export function names(table: string, months: readonly string[]): string[] {
  return months.map((m) => `${table}_p${m.slice(0, 4)}${m.slice(5, 7)}`);
}

/**
 * createPartitionMaintenance(options), or — when creating throws — a stand-in whose three methods
 * reject with that error, so that a scenario fails on its assertions rather than on a throw.
 */
export function createOrStub(options: PartitionMaintenanceOptions): PartitionMaintenance {
  try {
    return createPartitionMaintenance(options);
  } catch (error) {
    const fail = async (): Promise<never> => {
      throw error;
    };
    return { runOnce: fail, start: fail, stop: fail };
  }
}

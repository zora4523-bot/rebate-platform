// Shared helpers of the B1-03w rule tests: the risk-scan chain's job names against the queue's
// job-name rule (apps/api/src/modules/platform/queue/validation.ts validateSend: a name matches
// /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, so 'freeze-expiry' / 'daily-alerts' were rejected with
// QueueError('invalid_name') and the chain never got a job). Orchestrator ruling §9.2: the names are
// `freeze_expiry` and `daily_alerts`; the singletonKey prefix stays readable and is the
// implementation's choice (`freeze-expiry:` or `freeze_expiry:`), so expected keys accept both.
// Nothing here opens a database connection or imports the test-database base (see ./int-kit.ts).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import {
  QUEUE_CATALOG,
  QueueError,
  type JobPayload,
  type JobQueue,
  type QueueSpec,
  type ReceivedJob,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { validateSend } from '../../../../apps/api/src/modules/platform/queue/validation.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';

/** The two job names fixed by the orchestrator (§9.2 #1). */
export const JOB_NAMES = ['daily_alerts', 'freeze_expiry'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Readable key prefixes: either spelling of §9.2 #2, the same one for every send of a name. */
export const KEY_PREFIX: Readonly<Record<JobName, string>> = {
  freeze_expiry: 'freeze[-_]expiry',
  daily_alerts: 'daily[-_]alerts',
};

/** A matcher of `<prefix>:<slot>` for the job `name` (slot: UTC minute or +08:00 day). */
export function keyPattern(name: JobName, slot: string): RegExp {
  return new RegExp(`^${KEY_PREFIX[name]}:${slot.replaceAll('.', '\\.')}$`);
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;

/** `YYYY-MM-DDTHH:mm` (UTC) of the minute `ms` falls in. */
export function minuteOf(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString().slice(0, 16);
}

/** `YYYY-MM-DD` of the +08:00 calendar day `ms` falls in. */
export function dayOf(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

export interface Clock {
  now(): Date;
  set(value: Date | string): void;
  advanceMs(value: number): void;
}

export interface RiskState {
  setRiskState(trx: unknown, command: unknown): Promise<void>;
}

/** The assembled scan (risk-scan.ts RiskScan, heal() of B1-03u included). */
export interface Scan {
  expireFrozen(): Promise<void>;
  dailyAlerts(): Promise<void>;
  seed(): Promise<void>;
  handle(job: ReceivedJob): Promise<void>;
  heal(): Promise<void>;
}

export interface ScanOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskState;
  readonly queue: JobQueue;
  readonly logger: RootLogger;
}

export interface ScanModule {
  createRiskScan(options: ScanOptions): Scan;
  /** The worker's startup hook (entry.ts): seeds once, logs `risk_scan_seed_failed` on failure. */
  seedRiskScan(resolve: () => unknown, logger: RootLogger, stopping: () => boolean): Promise<void>;
}

export async function scanModule(): Promise<ScanModule> {
  return (await import(
    new URL('../../../../apps/api/src/modules/risk/application/risk-scan.ts', import.meta.url).href
  )) as ScanModule;
}

export async function fixedClock(instant: Date | string): Promise<Clock> {
  const { FixedClock } = (await import(
    new URL('../../../../apps/api/src/modules/platform/clock/index.ts', import.meta.url).href
  )) as { FixedClock: new (instant: Date | string) => Clock };
  return new FixedClock(instant);
}

export function memoryLogger(): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

/** Parsed log lines whose message is one of `messages`. */
export function linesOf(lines: readonly string[], messages: readonly string[]) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => messages.includes(line['msg'] as string));
}

export function describeError(error: unknown): string {
  if (error instanceof QueueError) return `QueueError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** How a promise settled: 'resolved' or describeError of its rejection (never rejects). */
export function settle(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => describeError(error),
  );
}

/** A received job of the risk-scan queue as the runtime hands it to the handler. */
export function receivedJob(name: string): ReceivedJob {
  return Object.freeze({ id: randomUUID(), queue: 'risk-scan', name, payload: {}, attempt: 1 });
}

/** The production catalog entry of the risk-scan queue (exclusive, B1-03j). */
export function riskScanSpec(): QueueSpec {
  const spec = QUEUE_CATALOG.find((item) => item.name === 'risk-scan');
  if (spec === undefined) throw new Error('risk-scan is missing from QUEUE_CATALOG');
  return spec;
}

/** Which of the chain's three send sites a send came from (set by the test before each call). */
export type Phase = 'seed' | 'continue' | 'heal';

export interface Sent {
  readonly phase: Phase;
  readonly queue: string;
  readonly name: string;
  readonly singletonKey: string | undefined;
  readonly delaySeconds: number | undefined;
  readonly trx: unknown;
  /** 'accepted' or describeError of what the send rejected with. */
  readonly outcome: string;
}

/**
 * A JobQueue double that checks every send exactly as QueueRuntime.send does before touching the
 * database: catalog queue ('unknown_queue'), then the real validateSend of platform/queue. A send
 * that fails a check rejects with that QueueError; an accepted one resolves with a new id.
 */
export function validatingQueue() {
  const spec = riskScanSpec();
  const sends: Sent[] = [];
  const state = { phase: 'seed' as Phase };
  const queue: JobQueue = {
    async send(queueName: string, name: string, payload: JobPayload, options: SendOptions) {
      let failure: { readonly error: unknown } | null = null;
      try {
        if (queueName !== spec.name) throw new QueueError('unknown_queue');
        validateSend(spec, name, payload, options);
      } catch (error) {
        failure = { error };
      }
      sends.push({
        phase: state.phase,
        queue: queueName,
        name,
        singletonKey: options.singletonKey,
        delaySeconds: options.delaySeconds,
        trx: options.trx,
        outcome: failure === null ? 'accepted' : describeError(failure.error),
      });
      if (failure !== null) throw failure.error;
      return randomUUID();
    },
  };
  return {
    queue,
    sends,
    phase(phase: Phase) {
      state.phase = phase;
    },
  };
}

/** Real query compilation, empty results, no socket or database. */
export function emptyDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

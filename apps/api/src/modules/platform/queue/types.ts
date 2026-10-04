import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/logger.ts';

/** pg-boss schema version that db/migrations/0002_pgboss-schema-v42.sql installs. */
export const PGBOSS_SCHEMA_VERSION = 42;
/** Schema of the pg-boss tables (db/AGENTS.md, AGENTS.md §9). */
export const PGBOSS_SCHEMA = 'pgboss';
/** Upper bound of UTF-8 bytes of JSON.stringify(payload) (section 3d). */
export const MAX_PAYLOAD_BYTES = 16_384;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JobPayload;
export interface JobPayload {
  readonly [key: string]: JsonValue;
}

export type QueuePolicy = 'standard' | 'exclusive';

export interface QueueSpec {
  readonly name: string;
  readonly policy: QueuePolicy;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  readonly retryDelayMaxSeconds: number | null;
  readonly expireInSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
  readonly deadLetter: string | null;
}

export interface WorkSpec {
  readonly queue: string;
  readonly concurrency: number;
  readonly pollingIntervalSeconds: number;
}

export type EntryPlan = Readonly<Record<EntryName, readonly WorkSpec[]>>;

export interface SendOptions {
  /** Required: the business transaction (same-transaction enqueue) or null (section 3). */
  readonly trx: Transaction<DB> | null;
  readonly id?: string;
  readonly singletonKey?: string;
  readonly delaySeconds?: number;
}

/** What business code depends on (ADR-0001 §2). */
export interface JobQueue {
  send(
    queue: string,
    name: string,
    payload: JobPayload,
    options: SendOptions,
  ): Promise<string | null>;
}

export interface ReceivedJob {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly attempt: number;
}

export type JobHandler = (job: ReceivedJob) => Promise<void>;

export interface QueueRuntime extends JobQueue {
  register(queue: string, handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface QueueRuntimeOptions {
  readonly entry: EntryName;
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly catalog?: readonly QueueSpec[];
  readonly plan?: EntryPlan;
  readonly stopTimeoutMs?: number;
}

export type QueueErrorCode =
  | 'invalid_catalog'
  | 'invalid_option'
  | 'unknown_queue'
  | 'invalid_name'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'not_in_entry'
  | 'duplicate_handler'
  | 'already_started'
  | 'not_running'
  | 'schema_mismatch'
  | 'queue_mismatch';

/** The fixed message of each code (section 8). */
export const QUEUE_ERROR_MESSAGES: Readonly<Record<QueueErrorCode, string>> = Object.freeze({
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
});

export class QueueError extends Error {
  readonly code: QueueErrorCode;

  constructor(code: QueueErrorCode) {
    super(QUEUE_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'QueueError';
  }
}

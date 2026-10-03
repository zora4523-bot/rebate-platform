// Shared helpers of the platform/db rule tests (ADR-0001 §4.2 第 11、20 项; ADR-0002 §5;
// 规划/02 §3.1, §12.6). Expected values are written out by hand from the contract in
// apps/api/src/modules/platform/db/index.ts, never taken from the implementation.
// Connection URLs and the passwords in them are built by code from small labels: no credential
// literal appears in the rule tests (gitleaks), and every password is distinctive enough that a
// search for it cannot hit anything else.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may.
import { createHash } from 'node:crypto';
import net from 'node:net';
import { vi } from 'vitest';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { DbError, type DbErrorCode } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';

export const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
export type Entry = (typeof ENTRIES)[number];

export type VarName = 'DATABASE_URL' | 'DATABASE_READ_URL' | 'REDIS_URL';

/** The variables each entry must have, copied from section 1 of the contract. */
export const REQUIRED: Readonly<Record<Entry, readonly VarName[]>> = {
  api: ['DATABASE_URL', 'REDIS_URL'],
  stream: ['DATABASE_URL', 'REDIS_URL'],
  admin: ['DATABASE_URL', 'DATABASE_READ_URL', 'REDIS_URL'],
  worker: ['DATABASE_URL', 'REDIS_URL'],
  payout: ['DATABASE_URL'],
};

/** The variables an entry does not read (section 1: "ignored"). */
export function ignoredBy(entry: Entry): VarName[] {
  const all: VarName[] = ['DATABASE_URL', 'DATABASE_READ_URL', 'REDIS_URL'];
  return all.filter((name) => !REQUIRED[entry].includes(name));
}

/** Pool sizes of ADR-0001 §4.2 #11, copied by hand. */
export const SIZES: Readonly<Record<Entry, { db: number; dbRead: number | null }>> = {
  api: { db: 10, dbRead: null },
  stream: { db: 5, dbRead: null },
  admin: { db: 3, dbRead: 5 },
  worker: { db: 10, dbRead: null },
  payout: { db: 3, dbRead: null },
};

export const MESSAGES = {
  pg: 'must be a postgres:// or postgresql:// URL with a user, a host and a database name',
  redis: 'must be a redis:// or rediss:// URL with a host',
} as const;

export const DB_ERROR_MESSAGES: Readonly<Record<DbErrorCode, string>> = {
  closed: 'database handles are closed',
  invalid_option: 'closeTimeoutMs must be an integer from 1 to 60000',
};

export function missing(name: VarName, entry: Entry): string {
  return `${name}: must be set for the ${entry} entry`;
}

export function malformed(name: VarName): string {
  return `${name}: ${name === 'REDIS_URL' ? MESSAGES.redis : MESSAGES.pg}`;
}

/** 24 hex characters derived from a label: a password nobody would pick by accident. */
export function hexOf(label: string): string {
  return createHash('sha256').update(`couli-db-rule-test:${label}`).digest('hex').slice(0, 24);
}

/**
 * A password with characters that a URL must percent-encode, so that the raw and the encoded
 * forms differ: `<hex>@<hex>/<hex>`.
 */
export function phraseOf(label: string): string {
  const hex = hexOf(label);
  return `${hex.slice(0, 8)}@${hex.slice(8, 16)}/${hex.slice(16)}`;
}

/** Every form in which `phrase` could show up in a printed value. */
export function formsOf(phrase: string): string[] {
  const bytes = Buffer.from(phrase, 'utf8');
  return [
    phrase,
    encodeURIComponent(phrase),
    ...phrase.split(/[@/]/),
    bytes.toString('hex'),
    bytes.toString('base64'),
    bytes.toString('base64url'),
  ];
}

/** The forms of any of `phrases` that occur in `text` (an empty list when none does). */
export function leaksIn(text: string, phrases: readonly string[]): string[] {
  return phrases.flatMap((phrase) => formsOf(phrase).filter((form) => text.includes(form)));
}

/** A postgres URL of a role with an encoded password, to a local port nothing listens on. */
export function pgUrlOf(role: string, phrase: string, database = 'couli'): string {
  return `postgres://${role}:${encodeURIComponent(phrase)}@127.0.0.1:1/${database}`;
}

/** The redacted form of `pgUrlOf(role, …, database)` (section 3). */
export function pgRedactedOf(role: string, database = 'couli'): string {
  return `postgres://${role}:***@127.0.0.1:1/${database}`;
}

export function redisUrlOf(phrase: string): string {
  return `redis://:${encodeURIComponent(phrase)}@127.0.0.1:1/0`;
}

export const REDIS_REDACTED = 'redis://:***@127.0.0.1:1/0';

/** URLs whose passwords are the phrases of the labels `<label>.db`, `<label>.read`, `<label>.redis`. */
export function urlsOf(label: string): {
  readonly env: Record<VarName, string>;
  readonly phrases: Record<VarName, string>;
} {
  const phrases = {
    DATABASE_URL: phraseOf(`${label}.db`),
    DATABASE_READ_URL: phraseOf(`${label}.read`),
    REDIS_URL: phraseOf(`${label}.redis`),
  };
  return {
    phrases,
    env: {
      DATABASE_URL: pgUrlOf('couli_app', phrases.DATABASE_URL),
      DATABASE_READ_URL: pgUrlOf('couli_readonly', phrases.DATABASE_READ_URL),
      REDIS_URL: redisUrlOf(phrases.REDIS_URL),
    },
  };
}

/** The variables `entry` requires, taken from `all`. */
export function envFor(entry: Entry, all: Record<VarName, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of REQUIRED[entry]) env[name] = all[name];
  return env;
}

/**
 * How a synchronous call ended: `returned`, `ConfigError [<problems>]`, `DbError <code>` or
 * `<name>: <message>` for anything else (so that NotImplemented shows in the assertion diff).
 */
export function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return describeError(error);
  }
  return 'returned';
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return `ConfigError ${JSON.stringify(error.problems)}`;
  if (error instanceof DbError) return `DbError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** How a promise settled: `resolved`, or `describeError` of the reason. */
export async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return describeError(error);
  }
  return 'resolved';
}

/** The ConfigError thrown by `run`, or a description of what happened instead. */
export function configErrorOf(run: () => unknown): ConfigError | string {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error : describeError(error);
  }
  return 'returned';
}

/** One V8 stack frame: `    at [async ][function (]location[)]`. */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly a ConfigError with these problems: an empty list when its name is
 * 'ConfigError', `problems` is exactly the list, the message is exactly the one ConfigError
 * builds, the stack is that message followed by plain frames, and it has no other own property
 * (no `cause`).
 */
export function configErrorProblems(error: unknown, problems: readonly string[]): string[] {
  if (!(error instanceof ConfigError)) return [`not a ConfigError: ${describeError(error)}`];
  const found: string[] = [];
  const message = `Invalid environment configuration:\n${problems.map((p) => `- ${p}`).join('\n')}`;
  if (error.name !== 'ConfigError') found.push('name');
  if (JSON.stringify(error.problems) !== JSON.stringify(problems)) found.push('problems');
  if (error.message !== message) found.push('message');
  const head = `ConfigError: ${message}`;
  const stack = error.stack ?? '';
  if (!stack.startsWith(`${head}\n`)) found.push('stack head');
  const frames = stack.slice(head.length + 1).split('\n');
  if (frames.length === 0 || frames.some((line) => !FRAME.test(line))) found.push('stack frames');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['message', 'name', 'problems', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** The same check for a DbError of `code` (section 7). */
export function dbErrorProblems(error: unknown, code: DbErrorCode): string[] {
  if (!(error instanceof DbError)) return [`not a DbError: ${describeError(error)}`];
  const found: string[] = [];
  const message = DB_ERROR_MESSAGES[code];
  if (error.name !== 'DbError') found.push('name');
  if (error.code !== code) found.push(`code ${String(error.code)}`);
  if (error.message !== message) found.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `DbError: ${message}`) found.push('stack head');
  if (frames.length === 0 || frames.some((line) => !FRAME.test(line))) found.push('stack frames');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['code', 'message', 'name', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** The rejection of `promise` checked as a DbError of `code`; `resolved` when it resolved. */
export async function rejectionProblems(
  promise: Promise<unknown>,
  code: DbErrorCode,
): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return dbErrorProblems(error, code);
  }
  return ['resolved'];
}

/** A root logger of `entry` that writes its JSON lines into `lines`. */
export function memoryLogger(entry: Entry): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry, appEnv: 'test' },
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
 * A raw log line checked and reduced: it must be one JSON object with no key twice (its
 * re-serialisation equals the raw line), an ISO `time` and `pid` equal to `pid`. Returns the
 * record without `time` and `pid` for a deep comparison, or a string saying what is wrong.
 */
export function reduceLine(raw: string, pid: number): Record<string, unknown> | string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return `not JSON: ${raw}`;
  }
  if (`${JSON.stringify(record)}\n` !== raw) return `not one plain JSON line: ${raw}`;
  const { time, pid: linePid, ...rest } = record;
  if (typeof time !== 'string' || !ISO_TIME.test(time)) return `time: ${String(time)}`;
  if (linePid !== pid) return `pid: ${String(linePid)}`;
  return rest;
}

/** The expected reduced line (see reduceLine) of the logger of `memoryLogger(entry)`. */
export function line(
  entry: Entry,
  level: 'warn' | 'error',
  fields: Record<string, unknown>,
  msg: string,
): Record<string, unknown> {
  return { level: level === 'warn' ? 40 : 50, entry, env: 'test', ...fields, msg };
}

/**
 * Counts the connection attempts of every TCP socket of this process (pg connects through
 * `net.Socket#connect`) until `restore` is called. Calls go through unchanged.
 */
export function watchSocketConnects(): { count: () => number; restore: () => void } {
  const spy = vi.spyOn(net.Socket.prototype, 'connect');
  return {
    count: () => spy.mock.calls.length,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** Lets pending callbacks, timers of 0 ms and I/O callbacks run. */
export async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Waits until `ready()` is true, polling every 20 ms, for at most `limitMs`. */
export async function waitFor(ready: () => boolean, limitMs: number): Promise<boolean> {
  const until = performance.now() + limitMs;
  while (!ready()) {
    if (performance.now() > until) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  return true;
}

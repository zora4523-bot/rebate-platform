// Shared helpers of the platform/idempotency rule tests (规划/04 §5「幂等」, §3.2, §6.1, §7; 08
// BR-WDR-07, BR-ID-01 ④, BR-ID-08, BR-ID-10 细则「敏感操作的幂等键」, BR-ID-30 ⑤). Expected values
// are written out by hand from the contract in
// apps/api/src/modules/platform/idempotency/index.ts, never taken from the implementation.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import {
  IdempotencyError,
  type HandlerResult,
  type IdempotencyActor,
  type IdempotencyErrorCode,
  type IdempotencyLogger,
  type IdempotentRequest,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';

export const APP = 'couli';
export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const DAY_MS = 86_400_000;
export const RETENTION_MS = 30 * DAY_MS;

/** UUIDs built from a small number: lowercase canonical form (section 1). */
export function uuidOf(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `0199a3b4-5c6d-7e8f-9a0b-${hex}`;
}

/** A 64-hex blind-index-like value derived from a label (no literal that looks like a key). */
export function hmacOf(label: string): string {
  return createHash('sha256').update(`couli-idem-rule-test:${label}`).digest('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const USER_A = uuidOf(0xa1);
export const USER_B = uuidOf(0xb2);
export const DEVICE_A = uuidOf(0xd1);

export function userActor(userId: string = USER_A): IdempotencyActor {
  return { userId, deviceId: null, phoneHmac: null };
}

export function deviceActor(deviceId: string = DEVICE_A): IdempotencyActor {
  return { userId: null, deviceId, phoneHmac: null };
}

export function phoneActor(label = 'phone-a'): IdempotencyActor {
  return { userId: null, deviceId: null, phoneHmac: hmacOf(label) };
}

let keySeq = 0;
/** A fresh valid Idempotency-Key per call (8–64 of [A-Za-z0-9_-]). */
export function freshKey(prefix = 'rk'): string {
  keySeq += 1;
  return `${prefix}_${String(keySeq).padStart(6, '0')}_${String(process.pid)}`;
}

/** A standard idempotent request (POST /v1/links/<id>/open by default). */
export function request(overrides: Partial<IdempotentRequest> = {}): IdempotentRequest {
  return {
    appId: APP,
    actor: userActor(),
    method: 'POST',
    path: '/v1/links/0199a3b4-5c6d-7e8f-9a0b-00000000aaaa/open',
    key: freshKey(),
    body: { installed: 'unknown', no_rebate: false },
    traceId: TRACE,
    ...overrides,
  };
}

/** The four sensitive operations (section 6), copied by hand. */
export const SENSITIVE = {
  withdraw: { method: 'POST', path: '/v1/withdrawals', unlimited: true },
  payout_account_change: { method: 'PUT', path: '/v1/me/payout-account', unlimited: true },
  phone_change: { method: 'POST', path: '/v1/me/phone', unlimited: false },
  account_deletion: { method: 'POST', path: '/v1/me/deletion', unlimited: false },
} as const;
export type Action = keyof typeof SENSITIVE;
export const ACTIONS = Object.keys(SENSITIVE) as Action[];

export function sensitiveRequest(
  action: Action,
  overrides: Partial<IdempotentRequest> = {},
): IdempotentRequest {
  return request({
    method: SENSITIVE[action].method,
    path: SENSITIVE[action].path,
    body: { amount_fen: 10000 },
    ...overrides,
  });
}

/** A handler result whose envelope keys come in the contract order. */
export function result(code: number, status: number, data?: unknown): HandlerResult {
  return data === undefined
    ? { status, envelope: { code, msg: code === 0 ? '' : `m${String(code)}`, trace_id: TRACE } }
    : {
        status,
        envelope: { code, msg: code === 0 ? '' : `m${String(code)}`, data, trace_id: TRACE },
      };
}

/**
 * Whether `actual` is the response `expected`: compared by structure (the order of the outer
 * object's properties does not matter); `body` is a string, so it still has to match byte for
 * byte.
 */
export function sameResponse(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

/** Exact bodies of the envelopes the module builds (section 5). */
export const BODIES = {
  e20001: (trace = TRACE) =>
    `{"code":20001,"msg":"Idempotency-Key is missing or malformed","data":{"fields":["idempotency-key"]},"trace_id":"${trace}"}`,
  e20901: (trace = TRACE) =>
    `{"code":20901,"msg":"Idempotency-Key was used with a different request body","trace_id":"${trace}"}`,
  e20903: (trace = TRACE) =>
    `{"code":20903,"msg":"Idempotency-Key was abandoned","trace_id":"${trace}"}`,
  e40901: (trace = TRACE) =>
    `{"code":40901,"msg":"a request with this Idempotency-Key is in progress","trace_id":"${trace}"}`,
} as const;

export const RESPONSES = {
  e20001: { status: 400, body: BODIES.e20001(), source: 'idempotency' },
  e20901: { status: 409, body: BODIES.e20901(), source: 'idempotency' },
  e20903: { status: 409, body: BODIES.e20903(), source: 'idempotency' },
  e40901: { status: 409, body: BODIES.e40901(), source: 'idempotency' },
} as const;

export function abandonBody(outcome: 'abandoned' | 'completed', original: string): string {
  return `{"code":0,"msg":"","data":{"outcome":"${outcome}","original":${original}},"trace_id":"${TRACE}"}`;
}

export function describeError(error: unknown): string {
  if (error instanceof IdempotencyError) return `IdempotencyError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** Runs `run` (sync throw or rejection both caught): the value, or `{ error: describeError }`. */
export async function outcome<T>(run: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** Synchronous variant of `outcome`. */
export function outcomeSync<T>(run: () => T): T | { error: string } {
  try {
    return run();
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** Why `error` is not exactly an IdempotencyError of `code` with `message` (section 10). */
export function idempotencyErrorProblems(
  error: unknown,
  code: IdempotencyErrorCode,
  message: string,
): string[] {
  if (!(error instanceof IdempotencyError))
    return [`not an IdempotencyError: ${describeError(error)}`];
  const found: string[] = [];
  if (error.name !== 'IdempotencyError') found.push('name');
  if (error.code !== code) found.push(`code ${String(error.code)}`);
  if (error.message !== message) found.push('message');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['code', 'message', 'name', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** A db handle that fails the test's expectation as soon as anything touches it. */
export const POISON_DB_MESSAGE = 'poison: the database handle was used';
export function poisonDb(): Kysely<DB> {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(POISON_DB_MESSAGE);
      },
      has() {
        throw new Error(POISON_DB_MESSAGE);
      },
      apply() {
        throw new Error(POISON_DB_MESSAGE);
      },
    },
  ) as unknown as Kysely<DB>;
}

/** A logger recording every call of every pino method name. */
export function recordingLogger(): {
  logger: IdempotencyLogger;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const logger = {
    warn: record('warn'),
    info: record('info'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
    fatal: record('fatal'),
    child: record('child'),
  };
  return { logger, calls };
}

/** A promise with its resolver: the handler waits on it to keep a request in flight. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Resolves to the value of `promise`, or to 'timeout' after `ms`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ----- database helpers (used by the *.int.test.ts files with a couli_app Kysely) -----

export interface StoredRow {
  subject: string;
  user_id: string | null;
  method: string;
  path: string;
  key: string;
  request_hash: string | null;
  status: string;
  response: unknown;
  created: string;
  expire: string;
}

/** Every committed row of `key` (any scope), oldest first, timestamps as ISO UTC or 'infinity'. */
export async function rowsOf(db: Kysely<DB>, key: string): Promise<StoredRow[]> {
  const result = await sql<StoredRow>`
    SELECT subject, user_id::text AS user_id, method, path, key, request_hash, status, response,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
      CASE WHEN expire_at = 'infinity'::timestamptz THEN 'infinity'
        ELSE to_char(expire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS expire
    FROM app.idempotency_keys WHERE key = ${key} ORDER BY id
  `.execute(db);
  return result.rows;
}

/** A business write the handlers make: one processed_events row of consumer `label`. */
export async function businessWrite(db: Kysely<DB>, label: string, n: number): Promise<void> {
  await sql`INSERT INTO app.processed_events (consumer, event_id) VALUES (${label}, ${uuidOf(n)}::uuid)`.execute(
    db,
  );
}

export async function businessCount(db: Kysely<DB>, label: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.processed_events WHERE consumer = ${label}
  `.execute(db);
  return Number(result.rows[0]?.n ?? '-1');
}

/** ISO string of `base` plus `ms`. */
export function isoPlus(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

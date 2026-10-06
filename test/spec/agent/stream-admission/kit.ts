// Integration fixture of the admission gate: one-shot Redis (acquireTestRedis), a fresh namespace
// per test (no FLUSH, no SCAN), two independent handles (two service instances) sharing it, and a
// FixedClock. Keys are only those the gate handed to Redis; no key format is assumed.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createRedisAdmission,
  type Admission,
  type AdmissionLimits,
  type AdmissionRequest,
  type AdmissionResult,
  type AdmissionTicket,
  type QuotaSubject,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
export async function acquireRedis(): Promise<TestRedis | undefined> {
  const testing = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const acquire = testing['acquireTestRedis'];
  if (typeof acquire === 'function') return (acquire as () => Promise<TestRedis>)();
  return undefined;
}

export const START = '2026-10-06T10:00:00+08:00';
/** Wide limits: a test narrows only the one it exercises. */
export function limits(narrow: Partial<AdmissionLimits> = {}): AdmissionLimits {
  return {
    memberDaily: 100,
    guestDaily: 100,
    guestIpDaily: 100,
    perMinute: 100,
    maxRounds: 100,
    ...narrow,
  };
}
export function member(): QuotaSubject {
  return { tier: 'member', userId: `u-${randomUUID()}` };
}
export function guest(deviceHash: string, ipKey: string, loggedIn = false): QuotaSubject {
  return { tier: 'guest', loggedIn, deviceHash, ipKey };
}
export function opaque(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
export function req(subject: QuotaSubject, sessionId = opaque('s'), clientMsgId = opaque('m')) {
  const request: AdmissionRequest = {
    sessionId,
    clientMsgId,
    runId: opaque('r'),
    messageId: opaque('msg'),
    subject,
  };
  return request;
}
export function accepted(result: AdmissionResult): { ticket: AdmissionTicket; quotaLeft: number } {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted')
    throw new Error(`expected accepted, got ${JSON.stringify(result)}`);
  return { ticket: result.ticket, quotaLeft: result.quotaLeft };
}

export interface Gate {
  clock: FixedClock;
  /** Two admissions on two handles (two service instances), same namespace and clock. */
  a: Admission;
  b: Admission;
  /** Every key the gate handed to Redis → [PTTL, JSON of its value]; gone keys are left out. */
  dump(): Promise<Record<string, [number, string]>>;
  /** dump() without the PTTLs (they shrink with real time): the stored values only. */
  values(): Promise<Record<string, string>>;
  /** Redis calls made by `a` (instance one) since the gate was built; reset freely. */
  calls: Calls;
  /** The next `n` evals (either instance) wait for each other and are sent together. */
  barrier(n: number): void;
}

const DUMP = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return {-2, ''} end
local data
if kind == 'string' then data = redis.call('GET', KEYS[1])
elseif kind == 'hash' then data = redis.call('HGETALL', KEYS[1])
elseif kind == 'zset' then data = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
elseif kind == 'set' then data = redis.call('SMEMBERS', KEYS[1])
elseif kind == 'list' then data = redis.call('LRANGE', KEYS[1], 0, -1)
else data = redis.call('DUMP', KEYS[1]) end
return {redis.call('PTTL', KEYS[1]), cjson.encode(data)}`;

export interface Calls {
  get: number;
  set: number;
  eval: number;
}

/** Holds every eval (both instances) until `n` have arrived, then lets them all go at once. */
interface Barrier {
  arm(n: number): void;
  pass(): Promise<void>;
}
function createBarrier(): Barrier {
  let need = 0;
  let waiting: (() => void)[] = [];
  return {
    arm(n) {
      need = n;
      waiting = [];
    },
    pass() {
      if (need === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= need) {
          const go = waiting;
          need = 0;
          waiting = [];
          for (const release of go) release();
        }
      });
    },
  };
}

function observed(
  ns: RedisNamespace,
  touched: Set<string>,
  calls: Calls,
  barrier: Barrier,
): RedisNamespace {
  return {
    get: (key) => {
      calls.get++;
      return ns.get(key);
    },
    set: (key, value, ttl) => {
      calls.set++;
      touched.add(key);
      return ns.set(key, value, ttl);
    },
    eval: (script, options) => {
      calls.eval++;
      for (const key of options.keys) touched.add(key);
      return barrier.pass().then(() => ns.eval(script, options));
    },
  };
}

export async function withGate(
  server: TestRedis | undefined,
  run: (gate: Gate) => Promise<void>,
  timing: { runMaxMs: number; lockGraceMs: number } = { runMaxMs: 20_000, lockGraceMs: 30_000 },
): Promise<void> {
  expect(server).toBeDefined();
  const logger = createRootLogger(
    { level: 'silent', entry: 'stream', appEnv: 'test' },
    { write: () => undefined },
  );
  const connection = loadConnectionConfig('stream', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
    REDIS_URL: server!.url,
  });
  const handles: RedisHandle[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const handle = await createRedisHandle(connection, { logger });
      expect(handle === null).toBe(false);
      handles.push(handle as RedisHandle);
    }
    const name = `adm${randomBytes(8).toString('hex')}`;
    const touched = new Set<string>();
    const clock = new FixedClock(START);
    const calls: Calls = { get: 0, set: 0, eval: 0 };
    const gateBarrier = createBarrier();
    const [one, two] = handles.map((handle, i) =>
      createRedisAdmission({
        redis: observed(
          handle.namespace(name),
          touched,
          i === 0 ? calls : { get: 0, set: 0, eval: 0 },
          gateBarrier,
        ),
        clock,
        ...timing,
      }),
    );
    const raw = handles[0]!.namespace(name);
    const dump = async () => {
      const out: Record<string, [number, string]> = {};
      for (const key of [...touched].sort()) {
        const row = (await raw.eval(DUMP, { keys: [key], args: [], ttlSeconds: 1 })) as [
          number,
          string,
        ];
        if (row[0] !== -2) out[key] = [row[0], row[1]];
      }
      return out;
    };
    const values = async () =>
      Object.fromEntries(Object.entries(await dump()).map(([key, row]) => [key, row[1]]));
    await run({
      clock,
      a: one!,
      b: two!,
      dump,
      values,
      calls,
      barrier: (n) => {
        gateBarrier.arm(n);
      },
    });
  } finally {
    for (const handle of handles) await handle.close();
  }
}

/** Expected ticket of `request`: built anew (no reference shared with what the gate got). */
export function ticketOf(
  request: AdmissionRequest,
  dayKey: string,
  acceptedAtMs: number,
  lockExpiresAtMs: number,
): AdmissionTicket {
  return {
    runId: request.runId,
    messageId: request.messageId,
    sessionId: request.sessionId,
    subject: structuredClone(request.subject),
    dayKey,
    acceptedAtMs,
    lockExpiresAtMs,
  };
}

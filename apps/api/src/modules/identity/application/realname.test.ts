// Unit tests of the daily attempt count per Idempotency-Key (B1-13d money review r1 S1). The
// database is a scripted Kysely driver and Redis a stand-in that applies the two scripts' rules;
// the scripts themselves run against real Redis in test/spec/identity/realname/**.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  type FieldCrypto,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import type { RealnameVerificationResult } from '../ports/realname-verifier.ts';
import {
  RELEASE_SCRIPT,
  RESERVE_SCRIPT,
  attemptTtlSeconds,
  createRealnameAttempts,
} from './realname-attempts.ts';
import { createRealnameService } from './realname.ts';

const NOW = '2026-09-29T10:00:00.000Z';
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-000000000042';
const COUNT_KEY = `${APP}:2026-09-29:${USER}`;
// A syntactically valid resident ID (check digit X) and a name; synthetic.
const BODY = { name: '测试姓名', idNo: '11010519491231002X' };

interface Row {
  status: string;
  name_cipher: Buffer | null;
}

/** Answers the service's statements from `state`; `failWrites` makes the next verified writes throw. */
function scriptedDb(state: { row: Row | undefined; failWrites: number }): Kysely<DB> {
  const answer = (query: CompiledQuery): QueryResult<unknown> => {
    const { sql, parameters } = query;
    if (sql.includes('from "app"."consent_records"')) return { rows: [{ accepted: true }] };
    if (sql.startsWith('select "status", "name_cipher" from "app"."realname"')) {
      return { rows: state.row === undefined ? [] : [state.row] };
    }
    if (sql.startsWith('select "id" from "app"."realname"')) return { rows: [] };
    if (sql.startsWith('insert into "app"."realname"')) {
      if (parameters.includes('verified')) {
        if (state.failWrites > 0) {
          state.failWrites -= 1;
          throw new Error('connection terminated');
        }
        const name = parameters.find(
          (p) => Buffer.isBuffer(p) && p.toString('utf8').startsWith('enc:realname.name:'),
        ) as Buffer;
        state.row = { status: 'verified', name_cipher: name };
        return { rows: [{ id: 'row' }] };
      }
      state.row = { status: 'failed', name_cipher: null };
      return { rows: [] };
    }
    throw new Error(`unexpected statement ${sql}`);
  };
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery) =>
      Promise.resolve().then(() => answer(query) as QueryResult<R>),
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** Applies RESERVE_SCRIPT / RELEASE_SCRIPT's rules to an in-memory map; records each call. */
function scriptedRedis() {
  const store = new Map<string, string>();
  const calls: { script: string; options: RedisScriptOptions }[] = [];
  const handle: RedisHandle = {
    namespace: () => ({
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
      eval: (script, options) => {
        calls.push({ script, options });
        const [count, mark] = options.keys as [string, string];
        const n = Number(store.get(count) ?? '0');
        if (script === RESERVE_SCRIPT) {
          if (store.has(mark)) return Promise.resolve(2);
          if (n >= Number(options.args[0])) return Promise.resolve(0);
          store.set(count, String(n + 1));
          store.set(mark, '1');
          return Promise.resolve(1);
        }
        if (script === RELEASE_SCRIPT) {
          if (!store.delete(mark)) return Promise.resolve(0);
          if (n <= 0) return Promise.resolve(0);
          store.set(count, String(n - 1));
          return Promise.resolve(1);
        }
        return Promise.reject(new Error('unknown script'));
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  };
  return { handle, store, calls };
}

const crypto: FieldCrypto = {
  currentKeyVersion: 1,
  encrypt: (plain, context) => `enc:${context}:${plain}`,
  decrypt: (cipher, context) => cipher.slice(`enc:${context}:`.length),
  keyVersionOf: () => 1,
  needsReencrypt: () => false,
  reencrypt: (cipher) => cipher,
  blindIndex: (value, context) => createHash('sha256').update(`${context}|${value}`).digest('hex'),
};

function setup() {
  const state: { row: Row | undefined; failWrites: number } = { row: undefined, failWrites: 0 };
  const redis = scriptedRedis();
  const verify = vi.fn<() => Promise<RealnameVerificationResult>>();
  const clock = new FixedClock(NOW);
  const service = createRealnameService({
    db: scriptedDb(state),
    clock,
    crypto,
    redis: redis.handle,
    verifier: { verify },
    logger: { info: () => undefined, warn: () => undefined },
  });
  const submit = (idempotencyKey: string) =>
    service.submit({ appId: APP, userId: USER, ...BODY, idempotencyKey });
  return { state, redis, verify, clock, submit };
}

it('[AC-B1-13d][BR-ID-25] the same key retried after a failed verified write counts once', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'match', provider: 'unit' });
  t.state.failWrites = 1;
  await expect(t.submit('key-aaaaaaaa')).rejects.toThrow('connection terminated');
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  await expect(t.submit('key-aaaaaaaa')).resolves.toEqual({
    code: 0,
    data: { realname_status: 'verified', masked_name: '***名' },
  });
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.verify).toHaveBeenCalledTimes(2);
  // The raw key never reaches Redis.
  for (const call of t.redis.calls) expect(call.options.keys.join()).not.toContain('key-aaaaaaaa');
});

it('[AC-B1-13d][BR-ID-25] different keys count one each, and the limit still applies', async () => {
  const t = setup();
  t.verify.mockResolvedValue({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-1111111a')).resolves.toEqual({ code: 30406 });
  await expect(t.submit('key-2222222b')).resolves.toEqual({ code: 30406 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('2');
  await expect(t.submit('key-3333333c')).resolves.toEqual({ code: 30406 });
  await expect(t.submit('key-4444444d')).resolves.toEqual({ code: 30410 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('3');
  expect(t.verify).toHaveBeenCalledTimes(3);
});

it('[AC-B1-13d][BR-ID-25] after 50401 the same key reserves again and finally counts once', async () => {
  const t = setup();
  t.verify.mockResolvedValueOnce({ outcome: 'timeout' });
  await expect(t.submit('key-bbbbbbbb')).resolves.toEqual({ code: 50401 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('0');
  expect([...t.redis.store.keys()]).toEqual([COUNT_KEY]);
  t.verify.mockResolvedValueOnce({ outcome: 'mismatch', provider: 'unit' });
  await expect(t.submit('key-bbbbbbbb')).resolves.toEqual({ code: 30406 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.redis.calls.map((c) => c.script)).toEqual([
    RESERVE_SCRIPT,
    RELEASE_SCRIPT,
    RESERVE_SCRIPT,
  ]);
});

it('[AC-B1-13d][BR-ID-25] a seen key whose retry times out keeps the earlier count', async () => {
  const t = setup();
  t.verify.mockResolvedValueOnce({ outcome: 'match', provider: 'unit' });
  t.state.failWrites = 1;
  await expect(t.submit('key-cccccccc')).rejects.toThrow();
  t.verify.mockResolvedValueOnce({ outcome: 'timeout' });
  await expect(t.submit('key-cccccccc')).resolves.toEqual({ code: 50401 });
  expect(t.redis.store.get(COUNT_KEY)).toBe('1');
  expect(t.redis.calls.map((c) => c.script)).toEqual([RESERVE_SCRIPT, RESERVE_SCRIPT]);
});

it('[AC-B1-13d][BR-ID-25] writes of one day key expire at one instant: the window never extends', async () => {
  const at = (iso: string) => new FixedClock(iso).now();
  const instants = [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T10:00:00.000Z',
    '2026-09-29T15:59:59.000Z',
  ].map((iso) => at(iso).getTime() + attemptTtlSeconds('2026-09-29', at(iso)) * 1000);
  expect(new Set(instants).size).toBe(1);
  // End of the +08:00 day 2026-09-29 plus one day of grace.
  expect(instants[0]).toBe(at('2026-09-30T16:00:00.000Z').getTime());
  expect(attemptTtlSeconds('2026-09-29', at('2026-10-05T00:00:00.000Z'))).toBe(1);

  const redis = scriptedRedis();
  const attempts = createRealnameAttempts(redis.handle);
  const slot = { appId: APP, userId: USER, day: '2026-09-29', idempotencyKey: 'key-dddddddd' };
  await attempts.reserve(slot, at('2026-09-29T10:00:00.000Z'));
  await attempts.release(slot, at('2026-09-29T12:00:00.000Z'));
  const [reserve, release] = redis.calls;
  expect(at('2026-09-29T10:00:00.000Z').getTime() + reserve!.options.ttlSeconds * 1000).toBe(
    at('2026-09-29T12:00:00.000Z').getTime() + release!.options.ttlSeconds * 1000,
  );
});

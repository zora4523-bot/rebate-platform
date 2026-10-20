// Unit tests of growth's landing channel (B1-11h): Kysely queries are compiled against an in-memory
// driver (no socket, no database); Redis is an in-memory fake of the count script.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createRootLogger,
  FixedClock,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import {
  createLandingInviteBinder,
  INVITE_FAIL_IP_CONTEXT,
  type LandingBindInput,
  type LandingInviteBinderDeps,
  type LandingPrecheckInput,
} from '../index.ts';
import { INVITE_FAIL_NAMESPACE, seenKey } from './invite-binder.ts';

const NOW = '2026-10-18T15:59:30.000Z'; // 23:59:30 +08:00: 30 s to the next day
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-00000000000a';
const INVITER = '019a0000-0000-7000-8000-00000000000b';
const PHONE = 'f'.repeat(64);
const IP = '203.0.113.9';
const ATTEMPT = 'attempt-key-1';
const blindIndex = (value: string, context: string) => `${context}|${value}`;
const PHONE_KEY = `${APP}:2026-10-18:${PHONE}`;
const IP_KEY = `${APP}:2026-10-18:ip:${blindIndex(IP, INVITE_FAIL_IP_CONTEXT)}`;

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function fakeRedis() {
  const store = new Map<string, string>();
  const state = { failGet: false, failEval: false };
  const evals: { keys: string[]; ttlSeconds: number }[] = [];
  const handle: RedisHandle = {
    namespace(name) {
      expect(name).toBe(INVITE_FAIL_NAMESPACE);
      return {
        async get(key) {
          if (state.failGet) throw new Error('redis down');
          return store.get(key) ?? null;
        },
        async set() {
          throw new Error('set is not used');
        },
        async eval(_script: string, options: RedisScriptOptions) {
          if (state.failEval) throw new Error('redis down');
          evals.push({ keys: [...options.keys], ttlSeconds: options.ttlSeconds });
          const counts: number[] = [];
          for (let i = 0; i < options.keys.length; i += 2) {
            const [key, seen] = [options.keys[i]!, options.keys[i + 1]!];
            if (store.has(seen)) {
              counts.push(0);
              continue;
            }
            store.set(seen, '1');
            const next = Number(store.get(key) ?? '0') + 1;
            store.set(key, String(next));
            counts.push(next);
          }
          return counts;
        },
      };
    },
    close: async () => {},
    onApplicationShutdown: async () => {},
  };
  return { handle, store, state, evals };
}

async function fixture() {
  const world = {
    inviter: { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'normal' } as
      { id: string; phone_hmac: string | null; status: string } | undefined,
    updated: 1n,
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    const rows = (value: unknown[]) => ({ rows: value as R[] });
    if (text.startsWith('SELECT pg_advisory_xact_lock(')) return rows([{}]);
    if (/"invite_code" = \$2/.test(text) || /"id" = \$2/.test(text)) {
      return rows(world.inviter ? [world.inviter] : []);
    }
    if (text.startsWith('update "app"."users"')) {
      return { rows: [] as R[], numAffectedRows: world.updated };
    }
    if (text.startsWith('insert into "app"."relation_change_logs"')) {
      return { rows: [] as R[], numAffectedRows: 1n };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const redis = fakeRedis();
  const values = new Map<string, unknown>();
  const risk = { state: 'normal' as 'normal' | 'frozen' | 'appealing' | 'banned' };
  const deletion = { stage: 'none' as 'none' | 'cooling' | 'processing' | 'done' };
  const deps: LandingInviteBinderDeps = {
    clock: new FixedClock(NOW),
    logger,
    redis: redis.handle,
    crypto: { blindIndex },
    config: {
      configValue: vi.fn<LandingInviteBinderDeps['config']['configValue']>(async (_app, key) =>
        values.has(key) ? { value: values.get(key), version: 1 } : null,
      ),
    },
    readRisk: vi.fn(async () => ({ state: risk.state, reason_category: null, frozen_until: null })),
    readDeletionStage: vi.fn(async () => deletion.stage),
  };
  const binder = createLandingInviteBinder(deps);
  const pre: LandingPrecheckInput = {
    app_id: APP,
    phone_hmac: PHONE,
    client_ip: IP,
    invite_code: ' k7q2mz ',
    attempt_key: ATTEMPT,
  };
  const bindInput: LandingBindInput = {
    app_id: APP,
    user_id: USER,
    inviter_id: INVITER,
    phone_hmac: PHONE,
    client_ip: IP,
    attempt_key: ATTEMPT,
  };
  return {
    world,
    queries,
    lines,
    redis,
    values,
    risk,
    deletion,
    deps,
    precheck: (input: Partial<LandingPrecheckInput> = {}) =>
      db.transaction().execute((trx) => binder.precheck(trx, { ...pre, ...input })),
    bind: (input: Partial<LandingBindInput> = {}) =>
      db.transaction().execute((trx) => binder.bind(trx, { ...bindInput, ...input })),
    writes: () => queries.filter((q) => /^(insert|update|delete)\b/i.test(q.sql)),
  };
}

it('[AC-B1-11h#8] switch off answers 30408 before Redis and the code; malformed switch 50001', async () => {
  const f = await fixture();
  f.redis.state.failGet = true;
  for (const value of [false, 'off']) {
    f.values.set('growth.invite_bind.enabled', value);
    expect(await f.precheck({ invite_code: '' })).toEqual({ ok: false, code: 30408 });
  }
  f.values.set('growth.invite_bind.enabled', 'invalid');
  expect(await f.precheck()).toEqual({ ok: false, code: 50001 });
  expect(f.queries).toEqual([]);
  expect(f.redis.evals).toEqual([]);
});

it('[AC-B1-11h#31] a malformed daily limit answers 50001 without counting', async () => {
  const f = await fixture();
  f.values.set('invite.fail_limit_per_day', 0);
  expect(await f.precheck({ invite_code: '' })).toEqual({ ok: false, code: 50001 });
  expect(f.redis.evals).toEqual([]);
});

it('[AC-B1-11h#11] the phone key or the IP key at the limit answers 42901 up to +08 midnight', async () => {
  for (const key of [PHONE_KEY, IP_KEY]) {
    const f = await fixture();
    f.redis.store.set(key, '5');
    expect(await f.precheck({ invite_code: '' })).toEqual({
      ok: false,
      code: 42901,
      retry_after_seconds: 30,
    });
    expect(f.redis.evals).toEqual([]);
    expect(f.queries).toEqual([]);
  }
  const f = await fixture();
  f.redis.store.set(PHONE_KEY, '4');
  f.redis.store.set(IP_KEY, '4');
  expect(await f.precheck({ invite_code: '' })).toEqual({ ok: false, code: 30401 });
});

it('[AC-B1-11h#30] a malformed code counts both keys once per attempt, IP only as its digest', async () => {
  const f = await fixture();
  for (const code of ['', '　\u200B', 'K7Q2M', 'I0O1LL']) {
    expect(await f.precheck({ invite_code: code })).toEqual({ ok: false, code: 30401 });
  }
  // One attempt key: counted once on each key, however often it is retried.
  expect(f.redis.store.get(PHONE_KEY)).toBe('1');
  expect(f.redis.store.get(IP_KEY)).toBe('1');
  expect(f.redis.evals[0]).toEqual({
    keys: [PHONE_KEY, seenKey(PHONE_KEY, PHONE, ATTEMPT), IP_KEY, seenKey(IP_KEY, PHONE, ATTEMPT)],
    ttlSeconds: 90,
  });
  expect(JSON.stringify(f.redis.evals)).not.toContain(`:ip:${IP}`);
  expect(f.queries).toEqual([]);
  expect(await f.precheck({ invite_code: '', attempt_key: 'attempt-key-2' })).toEqual({
    ok: false,
    code: 30401,
  });
  expect(f.redis.store.get(PHONE_KEY)).toBe('2');
  expect(f.redis.store.get(IP_KEY)).toBe('2');
});

it('[AC-B1-11h#10] a missing or unavailable inviter answers 30401 and counts', async () => {
  const f = await fixture();
  f.world.inviter = undefined;
  expect(await f.precheck()).toEqual({ ok: false, code: 30401 });
  f.world.inviter = { id: INVITER, phone_hmac: null, status: 'normal' };
  expect(await f.precheck({ attempt_key: 'k2' })).toEqual({ ok: false, code: 30401 });
  // The deletion stage comes from identity's port (app.module wires it, B1-15c).
  f.world.inviter = { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'deleted' };
  f.deletion.stage = 'done';
  expect(await f.precheck({ attempt_key: 'k3' })).toEqual({ ok: false, code: 30401 });
  f.deletion.stage = 'none';
  f.world.inviter = { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'normal' };
  f.risk.state = 'banned';
  expect(await f.precheck({ attempt_key: 'k4' })).toEqual({ ok: false, code: 30401 });
  expect(f.redis.store.get(PHONE_KEY)).toBe('4');
  expect(f.writes()).toEqual([]);
  // The lookup is scoped to the app and the normalised code.
  expect(f.queries[0]!.parameters).toEqual([APP, 'K7Q2MZ']);
});

it('[AC-B1-11h#2] an available inviter passes the precheck without writing or counting', async () => {
  const f = await fixture();
  expect(await f.precheck()).toEqual({ ok: true, inviter_id: INVITER });
  expect(f.writes()).toEqual([]);
  expect(f.redis.evals).toEqual([]);
});

it('[AC-B1-11h#33] Redis failing to read or to count answers 50001', async () => {
  const f = await fixture();
  f.redis.state.failGet = true;
  expect(await f.precheck()).toEqual({ ok: false, code: 50001 });
  f.redis.state.failGet = false;
  f.redis.state.failEval = true;
  expect(await f.precheck({ invite_code: '' })).toEqual({ ok: false, code: 50001 });
  f.redis.store.set(PHONE_KEY, 'x');
  f.redis.state.failEval = false;
  expect(await f.precheck()).toEqual({ ok: false, code: 50001 });
  expect(f.lines.join('')).not.toContain(PHONE);
  expect(f.lines.join('')).not.toContain(IP);
});

it('[AC-B1-11h#2] bind locks, judges the inviter again, updates conditionally and logs landing', async () => {
  const f = await fixture();
  const bound = await f.bind();
  expect(bound).toEqual({ result: 'bound', parent_id: INVITER, bound_at: new Date(NOW) });
  const texts = f.queries.map((q) => q.sql);
  expect(texts[0]).toMatch(/^SELECT pg_advisory_xact_lock\(/);
  const update = f.queries.find((q) => q.sql.startsWith('update "app"."users"'))!;
  expect(update.sql).toContain('"parent_id" is null');
  expect(update.sql).toContain('"self_bind_used" = $');
  expect(update.parameters).toContain('landing');
  const log = f.queries.find((q) => q.sql.startsWith('insert into "app"."relation_change_logs"'))!;
  expect(log.parameters).toEqual(
    expect.arrayContaining([APP, USER, INVITER, 'landing', `user:${USER}`]),
  );
});

it('[AC-B1-11h#24] an inviter banned since the precheck fails the bind with 30401 and counts', async () => {
  const f = await fixture();
  f.risk.state = 'banned';
  expect(await f.bind()).toEqual({ result: 'failed', code: 30401 });
  expect(f.writes()).toEqual([]);
  expect(f.redis.store.get(PHONE_KEY)).toBe('1');
  expect(f.redis.store.get(IP_KEY)).toBe('1');
});

it('[AC-B1-15c] an inviter in a deletion stage fails precheck and bind with 30401 and counts', async () => {
  const f = await fixture();
  f.deletion.stage = 'cooling';
  expect(await f.precheck()).toEqual({ ok: false, code: 30401 });
  expect(f.deps.readDeletionStage).toHaveBeenCalledWith(expect.anything(), {
    app_id: APP,
    user_id: INVITER,
  });
  expect(await f.bind({ attempt_key: 'k2' })).toEqual({ result: 'failed', code: 30401 });
  expect(f.writes()).toEqual([]);
  expect(f.redis.store.get(PHONE_KEY)).toBe('2');
  f.deletion.stage = 'none';
  expect(await f.precheck({ attempt_key: 'k3' })).toEqual({ ok: true, inviter_id: INVITER });
});

it('[AC-B1-11h#14] a conditional update matching no row answers 50001 without a relation log', async () => {
  const f = await fixture();
  f.world.updated = 0n;
  expect(await f.bind()).toEqual({ result: 'failed', code: 50001 });
  expect(f.queries.some((q) => q.sql.includes('relation_change_logs'))).toBe(false);
});

it('[AC-B1-11h#2] malformed inputs are caller bugs and throw before any query', async () => {
  const f = await fixture();
  await expect(f.precheck({ attempt_key: '' })).rejects.toThrow(TypeError);
  await expect(f.bind({ inviter_id: '' })).rejects.toThrow(TypeError);
  expect(f.queries).toEqual([]);
});

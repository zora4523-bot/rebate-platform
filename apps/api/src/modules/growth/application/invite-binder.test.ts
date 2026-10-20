import { createHash } from 'node:crypto';
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
import { LOGIN_LOGS_DEVICE_ID_CONTEXT } from '../../identity/index.ts';
import {
  createInviteBinder,
  createRegistrationInviteBinding,
  type InviteBindCommand,
  type InviteBindOptions,
  type InviteBinderDeps,
  type InviteBindingResult,
} from '../index.ts';
import { INVITE_FAIL_NAMESPACE, LOGIN_DEVICE_ID_CONTEXT } from './invite-binder.ts';
import { relationWriteLockKey } from '../infra/relation-lock.ts';

const NOW = '2031-05-06T09:00:00.000Z';
const APP = 'couli';
const USER = '019a0000-0000-7000-8000-00000000000a';
const INVITER = '019a0000-0000-7000-8000-00000000000b';
const PHONE = 'f'.repeat(64);
const KEY = `${INVITE_FAIL_NAMESPACE}:${APP}:2031-05-06:${PHONE}`;

interface World {
  user: {
    phone_hmac: string | null;
    created_at: Date;
    parent_id: string | null;
    self_bind_used: boolean;
  };
  child: boolean;
  inviter: { id: string; phone_hmac: string | null; status: string } | undefined;
  chain: { hit: boolean; truncated: boolean };
  updated: bigint;
  insertError: Error | null;
}

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const state = { failGet: false, failEval: false };
  const evals: { script: string; keys: string[]; ttlSeconds: number }[] = [];
  const handle: RedisHandle = {
    namespace(name) {
      return {
        async get(key) {
          if (state.failGet) throw new Error('redis down');
          return store.get(`${name}:${key}`)?.value ?? null;
        },
        async set() {
          throw new Error('set is not used by the binder');
        },
        async eval(script: string, options: RedisScriptOptions) {
          if (state.failEval) throw new Error('redis down');
          evals.push({ script, keys: [...options.keys], ttlSeconds: options.ttlSeconds });
          // COUNT_FAILURE's seen marker: SET NX EX on the second key; present → nothing counted.
          if (options.keys.length > 1) {
            const seen = `${name}:${options.keys[1]!}`;
            if (store.has(seen)) return 0;
            store.set(seen, { value: '1', ttl: options.ttlSeconds });
          }
          const key = `${name}:${options.keys[0]!}`;
          const current = store.get(key);
          const count = Number(current?.value ?? '0') + 1;
          store.set(key, { value: String(count), ttl: current?.ttl ?? options.ttlSeconds });
          return count;
        },
      };
    },
    close: async () => {},
    onApplicationShutdown: async () => {},
  };
  return { handle, store, state, evals };
}

// Compile real Kysely queries against an in-memory driver: no socket or database.
async function fixture(overrides: Partial<World> = {}) {
  const world: World = {
    user: {
      phone_hmac: PHONE,
      created_at: new Date('2031-05-05T09:00:00.000Z'),
      parent_id: null,
      self_bind_used: false,
    },
    child: false,
    inviter: { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'normal' },
    chain: { hit: false, truncated: false },
    updated: 1n,
    insertError: null,
    ...overrides,
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    const rows = (value: unknown[]) => ({ rows: value as R[] });
    if (text.startsWith('select "phone_hmac", "created_at"')) return rows([world.user]);
    if (text.startsWith('SELECT pg_advisory_xact_lock(')) return rows([{}]);
    if (/"parent_id" = \$2 limit/.test(text)) return rows(world.child ? [{ id: 'child' }] : []);
    if (/"invite_code" = \$2/.test(text)) return rows(world.inviter ? [world.inviter] : []);
    if (/WITH RECURSIVE chain/.test(text)) return rows([world.chain]);
    if (text.startsWith('update "app"."users"')) {
      return { rows: [] as R[], numAffectedRows: world.updated };
    }
    if (text.startsWith('insert into "app"."relation_change_logs"')) {
      if (world.insertError) throw world.insertError;
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
  const clock = new FixedClock(NOW);
  const redis = fakeRedis();
  const values = new Map<string, unknown>();
  const devices = new Map<string, string[]>();
  const orders = { count: 0, claims: false };
  const risk = { state: 'normal' as 'normal' | 'frozen' | 'appealing' | 'banned' };
  const deps: InviteBinderDeps = {
    clock,
    logger,
    redis: redis.handle,
    crypto: { blindIndex: (value, context) => `${context}|${value}` },
    config: {
      configValue: vi.fn<InviteBinderDeps['config']['configValue']>(async (_app, key) =>
        values.has(key) ? { value: values.get(key), version: 1 } : null,
      ),
    },
    loginDevices: { read: async (_trx, subject) => devices.get(subject.user_id) ?? [] },
    activity: () => ({
      orderCount: async () => orders.count,
      hasClaims: async () => orders.claims,
    }),
    readRisk: vi.fn(async () => ({
      state: risk.state,
      reason_category: null,
      frozen_until: null,
    })),
  };
  const command: InviteBindCommand = {
    channel: 'backfill',
    app_id: APP,
    user_id: USER,
    invite_code: 'K7Q2MZ',
    device_id: 'device-1',
  };
  const bind = (
    input: Partial<InviteBindCommand> = {},
    extra: Partial<InviteBinderDeps> = {},
    options?: InviteBindOptions,
  ): Promise<InviteBindingResult> => {
    const binder = createInviteBinder({ ...deps, ...extra });
    return db.transaction().execute((trx) => binder.bind(trx, { ...command, ...input }, options));
  };
  const writes = () => queries.filter((q) => /^(insert|update|delete)\b/i.test(q.sql));
  return {
    db,
    world,
    queries,
    lines,
    clock,
    redis,
    values,
    devices,
    orders,
    risk,
    deps,
    bind,
    writes,
  };
}

it('[AC-B1-11d#1] backfill without a phone answers 10005 before reading any configuration', async () => {
  const f = await fixture();
  f.world.user.phone_hmac = null;
  f.values.set('growth.invite_bind.enabled', false);
  expect(await f.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 10005 });
  expect(f.deps.config.configValue).not.toHaveBeenCalled();
  expect(f.writes()).toEqual([]);
});

it.each([false, 'off'])(
  '[AC-B1-11d#2] switch %s answers 30408 before Redis and the used chance',
  async (value) => {
    const f = await fixture();
    f.values.set('growth.invite_bind.enabled', value);
    f.world.user.self_bind_used = true;
    f.redis.state.failGet = true;
    expect(await f.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 30408 });
  },
);

it.each([
  ['growth.invite_bind.enabled', 'invalid'],
  ['invite.fail_limit_per_day', 0],
  ['invite.fail_limit_per_day', 1.5],
  ['invite.fail_limit_per_day', 'five'],
  ['invite.backfill_hours', -1],
  ['invite.backfill_hours', 2_147_483_648],
] as const)(
  '[AC-B1-11d#3] malformed %s=%s answers 50001 and writes nothing',
  async (key, value) => {
    const f = await fixture();
    f.values.set(key, value);
    expect(await f.bind()).toEqual({ result: 'failed', code: 50001 });
    expect(f.writes()).toEqual([]);
    expect(f.redis.store.size).toBe(0);
  },
);

it('[AC-B1-11d#3] register ignores invite.backfill_hours', async () => {
  const f = await fixture();
  f.values.set('invite.backfill_hours', -1);
  f.world.user.created_at = new Date('2020-01-01T00:00:00Z');
  expect(await f.bind({ channel: 'register' })).toMatchObject({ result: 'bound' });
});

it('[AC-B1-11d#23] the daily count reaches the limit: 42901 with seconds to 00:00 +08:00', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    expect(await f.bind({ invite_code: 'BAD' })).toEqual({ result: 'failed', code: 30401 });
  }
  expect(f.redis.store.get(KEY)).toEqual({ value: '5', ttl: 25200 + 60 });
  expect(await f.bind()).toEqual({ result: 'failed', code: 42901, retry_after_seconds: 25200 });
  expect(f.redis.store.get(KEY)?.value).toBe('5');
  expect(f.writes()).toEqual([]);
  f.clock.set('2031-05-06T16:00:00.000Z');
  expect(await f.bind()).toMatchObject({ result: 'bound' });
});

it('[AC-B1-11d#26] fail limit from configuration; Retry-After rounds up to one second', async () => {
  const f = await fixture();
  f.values.set('invite.fail_limit_per_day', 1);
  f.clock.set('2031-05-06T15:59:59.500Z');
  expect(await f.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 30401 });
  expect(await f.bind()).toEqual({ result: 'failed', code: 42901, retry_after_seconds: 1 });
});

it('[AC-B1-11d#24] the rate limit precedes the used chance', async () => {
  const f = await fixture();
  f.values.set('invite.fail_limit_per_day', 1);
  f.redis.store.set(KEY, { value: '1', ttl: 60 });
  f.world.user.parent_id = INVITER;
  expect(await f.bind()).toMatchObject({ result: 'failed', code: 42901 });
});

it.each(['parent', 'used'])(
  '[AC-B1-11d#4] %s answers 30402 before period, activity and format',
  async (kind) => {
    const f = await fixture();
    if (kind === 'parent') f.world.user.parent_id = INVITER;
    else f.world.user.self_bind_used = true;
    f.world.user.created_at = new Date('2031-01-01T00:00:00Z');
    f.orders.count = 1;
    expect(await f.bind({ invite_code: 'BAD' })).toEqual({ result: 'failed', code: 30402 });
    expect(f.redis.store.size).toBe(0);
  },
);

it.each([
  ['2031-04-29T09:00:01.000Z', 'bound'],
  ['2031-04-29T09:00:00.000Z', 30404],
] as const)('[AC-B1-11d#9][AC-B1-11d#10] created_at %s → %s', async (created, expected) => {
  const f = await fixture();
  f.world.user.created_at = new Date(created);
  if (expected === 'bound') {
    expect(await f.bind()).toMatchObject({ result: 'bound' });
  } else {
    // The period precedes the activity check and the format.
    f.orders.count = 1;
    expect(await f.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 30404 });
  }
});

it.each(['orders', 'claims', 'child'])(
  '[AC-B1-11d#6][AC-B1-11d#7][AC-B1-11d#8] %s → 30409',
  async (kind) => {
    const f = await fixture();
    if (kind === 'orders') f.orders.count = 2;
    if (kind === 'claims') f.orders.claims = true;
    if (kind === 'child') f.world.child = true;
    expect(await f.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 30409 });
    expect(f.redis.store.size).toBe(0);
  },
);

it('[AC-B1-11d#19] register skips the backfill period and activity checks', async () => {
  const f = await fixture();
  f.world.user.created_at = new Date('2020-01-01T00:00:00Z');
  f.orders.count = 3;
  f.world.child = true;
  expect(await f.bind({ channel: 'register' })).toMatchObject({ result: 'bound' });
});

it.each(['ABCDE', 'K7O2MZ', 'K702MZ', 'K7I2MZ', 'K712MZ', '', '　\t　'])(
  '[AC-B1-11d#12] malformed code %j: 30401 counted, no inviter lookup',
  async (code) => {
    const f = await fixture();
    expect(await f.bind({ invite_code: code })).toEqual({ result: 'failed', code: 30401 });
    expect(f.queries.some((q) => q.sql.includes('"invite_code"'))).toBe(false);
    expect(f.deps.readRisk).not.toHaveBeenCalled();
    expect(f.redis.store.get(KEY)?.value).toBe('1');
  },
);

it('[AC-B1-11d#13] full-width lowercase input matches after normalisation', async () => {
  const f = await fixture();
  expect(await f.bind({ invite_code: '　ｋ７ｑ２ｍｚ　' })).toMatchObject({ result: 'bound' });
  const lookup = f.queries.find((q) => q.sql.includes('"invite_code" = $2'));
  expect(lookup?.parameters).toEqual([APP, 'K7Q2MZ']);
});

it.each(['missing', 'banned', 'appealing', 'frozen', 'deleted', 'no phone'])(
  '[AC-B1-11d#14][AC-B1-11d#15][AC-B1-11d#16] inviter %s → 30401, counted, before conflicts',
  async (kind) => {
    const f = await fixture();
    if (kind === 'missing') f.world.inviter = undefined;
    if (kind === 'banned' || kind === 'appealing' || kind === 'frozen') f.risk.state = kind;
    if (kind === 'deleted') {
      f.world.inviter = { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'deleted' };
    }
    if (kind === 'no phone') f.world.inviter = { id: INVITER, phone_hmac: null, status: 'normal' };
    f.devices.set(USER, ['shared']);
    f.devices.set(INVITER, ['shared']);
    expect(await f.bind()).toEqual({ result: 'failed', code: 30401 });
    expect(f.redis.store.get(KEY)?.value).toBe('1');
    expect(f.queries.some((q) => /WITH RECURSIVE/.test(q.sql))).toBe(false);
    expect(f.writes()).toEqual([]);
  },
);

it.each([
  ['2013-05-08', 30401],
  ['2013-05-07', 30401],
  ['2013-05-05', 'bound'],
  [null, 'bound'],
] as const)(
  '[AC-B1-11d#52] verified birth date %j (BR-ID-26 age rule) → %s',
  async (birth, expected) => {
    const f = await fixture();
    const verifiedBirthDate = vi.fn(async () => birth);
    const result = await f.bind({}, { verifiedBirthDate });
    if (expected === 'bound') expect(result).toMatchObject({ result: 'bound' });
    else expect(result).toEqual({ result: 'failed', code: expected });
    expect(verifiedBirthDate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      app_id: APP,
      user_id: INVITER,
    });
  },
);

it.each([
  ['none', 'bound'],
  ['cooling', 30401],
  ['processing', 30401],
  ['done', 30401],
] as const)(
  '[AC-B1-15c] injected deletion stage %s → %s, read after risk',
  async (stage, expected) => {
    const f = await fixture();
    const order: string[] = [];
    const readRisk: InviteBinderDeps['readRisk'] = async (trx, subject) => {
      order.push('risk');
      return f.deps.readRisk(trx, subject);
    };
    const readDeletionStage = vi.fn(async () => {
      order.push('stage');
      return stage;
    });
    const result = await f.bind({}, { readRisk, readDeletionStage });
    if (expected === 'bound') expect(result).toMatchObject({ result: 'bound' });
    else expect(result).toEqual({ result: 'failed', code: expected });
    expect(readDeletionStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      app_id: APP,
      user_id: INVITER,
    });
    expect(order).toEqual(['risk', 'stage']);
  },
);

it('[AC-B1-15c] the injected stage overrides users.status (deleted row, port none → bound)', async () => {
  const f = await fixture();
  f.world.inviter = { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'deleted' };
  expect(await f.bind({}, { readDeletionStage: async () => 'none' })).toMatchObject({
    result: 'bound',
  });
});

it('[AC-B1-15c] without the port, users.status deleting counts as processing → 30401', async () => {
  const f = await fixture();
  f.world.inviter = { id: INVITER, phone_hmac: 'e'.repeat(64), status: 'deleting' };
  expect(await f.bind()).toEqual({ result: 'failed', code: 30401 });
  expect(f.redis.store.get(KEY)?.value).toBe('1');
});

it('[AC-B1-15c] an invalid code never reads the deletion stage', async () => {
  const f = await fixture();
  const readDeletionStage = vi.fn(async () => 'none' as const);
  expect(await f.bind({ invite_code: 'BAD' }, { readDeletionStage })).toEqual({
    result: 'failed',
    code: 30401,
  });
  expect(readDeletionStage).not.toHaveBeenCalled();
});

it('[AC-B1-11d#18] own code → 30403 without counting', async () => {
  const f = await fixture();
  f.world.inviter = { id: USER, phone_hmac: PHONE, status: 'normal' };
  expect(await f.bind()).toEqual({ result: 'failed', code: 30403 });
  expect(f.redis.store.size).toBe(0);
});

it('[AC-B1-11d#19] the invitee found above the inviter → 30403; the walk is bounded at 1000', async () => {
  const f = await fixture();
  f.world.chain = { hit: true, truncated: false };
  expect(await f.bind()).toEqual({ result: 'failed', code: 30403 });
  const walk = f.queries.find((q) => /WITH RECURSIVE/.test(q.sql));
  expect(walk?.parameters).toEqual([APP, INVITER, APP, 1000, USER, USER, 1000]);
  expect(f.redis.store.size).toBe(0);
});

it('[AC-B1-11d#37][AC-B1-11d#38] a walk cut at the limit counts as hit and warns without personal data', async () => {
  const f = await fixture();
  f.world.chain = { hit: false, truncated: true };
  expect(await f.bind()).toEqual({ result: 'failed', code: 30403 });
  const warnings = f.lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l['level'] === 40);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ msg: 'invite_bind_chain_limit', inviter_id: INVITER });
  const text = JSON.stringify(warnings);
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain('device-1');
  expect(text).not.toContain('K7Q2MZ');
});

it.each([
  ['history', ['a', 'shared'], ['shared'], 30403],
  ['this request', [], [`${LOGIN_DEVICE_ID_CONTEXT}|device-1`], 30403],
  ['disjoint', ['a'], ['b'], 'bound'],
] as const)(
  '[AC-B1-11d#20][AC-B1-11d#21][AC-B1-11d#22] devices %s → %s',
  async (_k, own, theirs, expected) => {
    const f = await fixture();
    f.devices.set(USER, [...own]);
    f.devices.set(INVITER, [...theirs]);
    const result = await f.bind();
    if (expected === 'bound') expect(result).toMatchObject({ result: 'bound' });
    else expect(result).toEqual({ result: 'failed', code: expected });
  },
);

it('[AC-B1-11d#31][AC-B1-11d#32] success: one Clock sample, conditional update, one relation log', async () => {
  const f = await fixture();
  const now = vi.fn(() => {
    const value = f.clock.now();
    f.clock.advanceMs(1000);
    return value;
  });
  expect(await f.bind({}, { clock: { now } })).toEqual({
    result: 'bound',
    parent_id: INVITER,
    bound_at: new Date(NOW),
  });
  expect(now).toHaveBeenCalledTimes(1);
  const [update, insert] = f.writes();
  expect(update?.sql).toBe(
    'update "app"."users" set "parent_id" = $1, "parent_bind_source" = $2, "parent_bound_at" = $3, ' +
      '"self_bind_used" = $4, "updated_at" = $5, "row_version" = row_version + 1 ' +
      'where "app_id" = $6 and "id" = $7 and "parent_id" is null and "self_bind_used" = $8',
  );
  expect(update?.parameters).toEqual([
    INVITER,
    'backfill',
    new Date(NOW),
    true,
    new Date(NOW),
    APP,
    USER,
    false,
  ]);
  expect(insert?.sql).toMatch(/^insert into "app"."relation_change_logs"/);
  expect(insert?.parameters).toEqual([
    APP,
    USER,
    null,
    INVITER,
    'backfill',
    `user:${USER}`,
    null,
    new Date(NOW),
  ]);
});

it('[AC-B1-11d#35][AC-B1-11d#36] the conditional update losing → 30402 and no log row', async () => {
  const f = await fixture({ updated: 0n });
  expect(await f.bind()).toEqual({ result: 'failed', code: 30402 });
  expect(f.writes().map((q) => q.sql.split(' ')[0])).toEqual(['update']);
});

it('[AC-B1-11d#34] a failing log insert rejects for the caller to roll back', async () => {
  const failure = new Error('audit down');
  const f = await fixture({ insertError: failure });
  await expect(f.bind()).rejects.toBe(failure);
});

it('[AC-B1-11d#28][AC-B1-11d#29] Redis failing to read or to count → 50001', async () => {
  const read = await fixture();
  read.redis.state.failGet = true;
  expect(await read.bind()).toEqual({ result: 'failed', code: 50001 });
  const count = await fixture();
  count.redis.state.failEval = true;
  expect(await count.bind({ invite_code: '' })).toEqual({ result: 'failed', code: 50001 });
  expect(count.writes()).toEqual([]);
});

it('[AC-B1-11d#29] a malformed stored count fails closed with 50001', async () => {
  const f = await fixture();
  f.redis.store.set(KEY, { value: 'x', ttl: 60 });
  expect(await f.bind()).toEqual({ result: 'failed', code: 50001 });
});

it('register without a phone has no count key and answers 50001', async () => {
  const f = await fixture();
  f.world.user.phone_hmac = null;
  expect(await f.bind({ channel: 'register' })).toEqual({ result: 'failed', code: 50001 });
});

it('a command without a signature device is a caller bug and rejects before any query', async () => {
  const f = await fixture();
  await expect(f.bind({ device_id: '' })).rejects.toThrow(TypeError);
  expect(f.queries).toEqual([]);
});

it.each([
  [30401, 30401],
  [30403, 30403],
  [30408, 30408],
  [42901, 42901],
  [10005, 50001],
  [30402, 50001],
  [30404, 50001],
  [30409, 50001],
  [50001, 50001],
] as const)('[AC-B1-11d#47] register adapter maps %i to %i', async (code, expected) => {
  const bind = vi.fn(async () => ({ result: 'failed' as const, code, retry_after_seconds: 5 }));
  const adapter = createRegistrationInviteBinding({ bind });
  const trx = {} as Parameters<typeof adapter>[0];
  expect(
    await adapter(trx, { app_id: APP, user_id: USER, invite_code: 'K7Q2MZ', device_id: 'd' }),
  ).toEqual({ result: 'failed', code: expected });
  expect(bind).toHaveBeenCalledExactlyOnceWith(trx, {
    channel: 'register',
    app_id: APP,
    user_id: USER,
    invite_code: 'K7Q2MZ',
    device_id: 'd',
  });
});

it('[AC-B1-11d#48] register adapter maps bound to { bound, code: null }', async () => {
  const adapter = createRegistrationInviteBinding({
    bind: async () => ({ result: 'bound', parent_id: INVITER, bound_at: new Date(NOW) }),
  });
  expect(
    await adapter({} as Parameters<typeof adapter>[0], {
      app_id: APP,
      user_id: USER,
      invite_code: 'K7Q2MZ',
      device_id: 'd',
    }),
  ).toEqual({ result: 'bound', code: null });
});

it('the login device context copy equals identity’s', () => {
  expect(LOGIN_DEVICE_ID_CONTEXT).toBe(LOGIN_LOGS_DEVICE_ID_CONTEXT);
});

it('[AC-B1-11d#35] review r1 S0: the app relation lock is taken before the child check, the walk and the update', async () => {
  const f = await fixture();
  expect(await f.bind()).toMatchObject({ result: 'bound' });
  const kinds = f.queries.map((q) =>
    q.sql.startsWith('SELECT pg_advisory_xact_lock(')
      ? 'lock'
      : /"parent_id" = \$2 limit/.test(q.sql)
        ? 'child'
        : /WITH RECURSIVE/.test(q.sql)
          ? 'walk'
          : q.sql.split(' ')[0],
  );
  expect(kinds).toEqual(['select', 'lock', 'child', 'select', 'walk', 'update', 'insert']);
  const lock = f.queries.find((q) => q.sql.startsWith('SELECT pg_advisory_xact_lock('));
  expect(lock?.sql).toBe('SELECT pg_advisory_xact_lock($1::bigint)');
  expect(lock?.parameters).toEqual([relationWriteLockKey(APP).toString()]);
});

it('[AC-B1-11d#19] review r1 S0: register takes the same lock before the walk', async () => {
  const f = await fixture();
  expect(await f.bind({ channel: 'register' })).toMatchObject({ result: 'bound' });
  const order = f.queries.map((q) => q.sql.slice(0, 30));
  const lock = order.findIndex((q) => q.startsWith('SELECT pg_advisory_xact_lock('));
  const walk = order.findIndex((q) => q.includes('WITH RECURSIVE'));
  expect(lock).toBeGreaterThan(-1);
  expect(walk).toBeGreaterThan(lock);
});

it('[AC-B1-11d#35] review r1 S0: failures before the relation checks never wait on the lock', async () => {
  const f = await fixture();
  f.world.user.parent_id = INVITER;
  expect(await f.bind()).toEqual({ result: 'failed', code: 30402 });
  const orders = await fixture();
  orders.orders.count = 1;
  expect(await orders.bind()).toEqual({ result: 'failed', code: 30409 });
  for (const queries of [f.queries, orders.queries]) {
    expect(queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
  }
});

it('review r1 S0: the relation lock key is stable per app and differs between apps', () => {
  expect(relationWriteLockKey('couli')).toBe(relationWriteLockKey('couli'));
  expect(relationWriteLockKey('couli')).not.toBe(relationWriteLockKey('couli2'));
  expect(relationWriteLockKey('a:b')).not.toBe(relationWriteLockKey('a'));
  for (const app of ['couli', 'x', '']) {
    const key = relationWriteLockKey(app);
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  }
});

it('review r1 S2: every configuration read goes through the caller transaction', async () => {
  const f = await fixture();
  await f.db.transaction().execute(async (trx) => {
    const binder = createInviteBinder(f.deps);
    expect(
      await binder.bind(trx, {
        channel: 'backfill',
        app_id: APP,
        user_id: USER,
        invite_code: 'K7Q2MZ',
        device_id: 'device-1',
      }),
    ).toMatchObject({ result: 'bound' });
    const calls = vi.mocked(f.deps.config.configValue).mock.calls;
    expect(calls.map((c) => c[1])).toEqual([
      'growth.invite_bind.enabled',
      'invite.fail_limit_per_day',
      'invite.backfill_hours',
    ]);
    for (const call of calls) expect(call[2]).toBe(trx);
  });
});

it('[AC-B1-11d#28] a closed Redis handle throwing from namespace() answers 50001 with no SQL write', async () => {
  const f = await fixture();
  const redis: RedisHandle = {
    ...f.redis.handle,
    namespace() {
      throw new Error('Redis unavailable: closed');
    },
  };
  expect(await f.bind({}, { redis })).toEqual({ result: 'failed', code: 50001 });
  expect(await f.bind({ invite_code: '' }, { redis })).toEqual({ result: 'failed', code: 50001 });
  expect(f.writes()).toEqual([]);
  expect(f.queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
});

const seenOf = (userId: string, attemptKey: string) =>
  `${KEY}:seen:${createHash('sha256')
    .update(JSON.stringify([userId, attemptKey]))
    .digest('hex')}`;

it('[AC-B1-11e#5] one attempt key counts once: a retry after a rolled-back commit adds nothing', async () => {
  const f = await fixture();
  const options = { attemptKey: 'key-retry-0001' };
  expect(await f.bind({ invite_code: '' }, {}, options)).toEqual({ result: 'failed', code: 30401 });
  expect(await f.bind({ invite_code: '' }, {}, options)).toEqual({ result: 'failed', code: 30401 });
  expect(f.redis.store.get(KEY)).toEqual({ value: '1', ttl: 25200 + 60 });
  const marker = seenOf(USER, 'key-retry-0001');
  expect(f.redis.store.get(marker)).toEqual({ value: '1', ttl: 25200 + 60 });
  // The raw key never reaches Redis; the marker sits under the day's count key.
  const prefix = `${APP}:2031-05-06:${PHONE}`;
  expect(f.redis.evals.map((call) => call.keys)).toEqual([
    [prefix, marker.slice(INVITE_FAIL_NAMESPACE.length + 1)],
    [prefix, marker.slice(INVITE_FAIL_NAMESPACE.length + 1)],
  ]);
  expect(JSON.stringify(f.redis.evals)).not.toContain('key-retry-0001');
  expect(f.redis.evals[0]!.script).toMatch(/SET', KEYS\[2\], '1', 'NX', 'EX', ARGV\[1\]/);
});

it('[AC-B1-11e#5] different attempt keys count once each and still reach the daily limit', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    expect(await f.bind({ invite_code: 'BAD' }, {}, { attemptKey: `key-distinct-${i}` })).toEqual({
      result: 'failed',
      code: 30401,
    });
  }
  expect(f.redis.store.get(KEY)?.value).toBe('5');
  expect(await f.bind({}, {}, { attemptKey: 'key-distinct-5' })).toEqual({
    result: 'failed',
    code: 42901,
    retry_after_seconds: 25200,
  });
});

it('[AC-B1-11e#5] the markers never extend the day: later failures keep the first TTL', async () => {
  const f = await fixture();
  expect(await f.bind({ invite_code: '' }, {}, { attemptKey: 'key-early-0001' })).toMatchObject({
    code: 30401,
  });
  f.clock.set('2031-05-06T15:00:00.000Z'); // 23:00 +08:00, one hour to midnight
  expect(await f.bind({ invite_code: '' }, {}, { attemptKey: 'key-late-00001' })).toMatchObject({
    code: 30401,
  });
  expect(await f.bind({ invite_code: '' }, {}, { attemptKey: 'key-early-0001' })).toMatchObject({
    code: 30401,
  });
  expect(f.redis.store.get(KEY)).toEqual({ value: '2', ttl: 25200 + 60 });
  expect(f.redis.store.get(seenOf(USER, 'key-early-0001'))?.ttl).toBe(25200 + 60);
  expect(f.redis.store.get(seenOf(USER, 'key-late-00001'))?.ttl).toBe(3600 + 60);
  // Every call asks for the TTL to the end of its own day only (set on creation by the script).
  expect(f.redis.evals.map((call) => call.ttlSeconds)).toEqual([25260, 3660, 3660]);
});

it('[AC-B1-11e#5] without an attempt key every 30401 counts (register channel unchanged)', async () => {
  const f = await fixture();
  expect(await f.bind({ invite_code: '' })).toMatchObject({ code: 30401 });
  expect(await f.bind({ invite_code: '' })).toMatchObject({ code: 30401 });
  expect(f.redis.store.get(KEY)?.value).toBe('2');
  expect(f.redis.evals.map((call) => call.keys.length)).toEqual([1, 1]);
});

it('[AC-B1-11e#5] a malformed attempt key is a programming error', async () => {
  const f = await fixture();
  await expect(f.bind({}, {}, { attemptKey: '' })).rejects.toThrow(TypeError);
  expect(f.redis.evals).toEqual([]);
});

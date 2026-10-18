// Unit tests of the risk state service's Redis version stamp (F1-07d) on a scripted pg transport
// and an in-memory RedisHandle: no database, no Redis, no listen. The rule tests
// (test/spec/risk/admin-risk-state) run the real Lua against Redis; these pin the cache choices.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, type EventBus, type RedisHandle } from '../../platform/index.ts';
import {
  RISK_STATE_STAMP_NAMESPACE,
  RiskStateConflictError,
  STAMP_TTL_SECONDS,
  createRiskStateService,
  raiseRiskStateStamp,
  type SetRiskState,
} from './risk-state.ts';

const SUBJECT = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000020' };
const KEY = `${SUBJECT.app_id}:${SUBJECT.user_id}`;

function scripted() {
  const statements: string[] = [];
  const state: {
    row: { state: string; reason_category: string | null; row_version: number } | null;
    insertError?: Error;
  } = { row: null };
  const client = {
    release() {},
    async query(text: string) {
      statements.push(text);
      if (/^insert\b/i.test(text)) {
        if (state.insertError !== undefined) throw state.insertError;
        return { command: 'INSERT', rowCount: 1, rows: [] };
      }
      if (/^update\b/i.test(text)) return { command: 'UPDATE', rowCount: 1, rows: [] };
      if (/^select\b/i.test(text) && text.includes('user_risk_state')) {
        const rows = state.row === null ? [] : [{ ...SUBJECT, frozen_until: null, ...state.row }];
        return { command: 'SELECT', rowCount: rows.length, rows };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const reads = () =>
    statements.filter((s) => /^select\b/i.test(s) && s.includes('user_risk_state')).length;
  return { db, state, statements, reads };
}

/** In-memory stand-in: eval applies the stamp's max rule (the real Lua runs in the rule tests). */
function memoryRedis() {
  const values = new Map<string, string>();
  const failures = { get: false, eval: false };
  const gets = vi.fn(async (key: string) => {
    if (failures.get) throw new Error('synthetic get failure');
    return values.get(key) ?? null;
  });
  const evals = vi.fn(
    async (_script: string, options: { keys: readonly string[]; args: readonly string[] }) => {
      if (failures.eval) throw new Error('synthetic eval failure');
      const key = options.keys[0]!;
      const wanted = Number(options.args[0]);
      const seen = values.get(key);
      if (seen === undefined || Number(seen) <= wanted) {
        values.set(key, String(wanted));
        return String(wanted);
      }
      return seen;
    },
  );
  const namespaces: string[] = [];
  const handle: RedisHandle = {
    namespace(name) {
      namespaces.push(name);
      return { get: gets, set: () => Promise.resolve(), eval: evals };
    },
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  };
  return { handle, values, failures, gets, evals, namespaces };
}

function service(redis?: RedisHandle) {
  const f = scripted();
  const publish = vi.fn<EventBus['publish']>(async () => ({ eventId: 'e', duplicate: false }));
  const clock = new FixedClock('2031-05-06T07:08:09Z');
  const risk = createRiskStateService({
    db: f.db,
    clock,
    events: { publish },
    ...(redis === undefined ? {} : { redis }),
  });
  return { ...f, publish, clock, risk };
}

const BAN: SetRiskState = {
  ...SUBJECT,
  state: 'banned',
  reason: 'internal note',
  reason_category: 'other',
  frozen_until: null,
  changed_by: 'unit_operator',
};

it('[F1-07d S2③] a database value below the Redis stamp decides the read but is not cached', async () => {
  const redis = memoryRedis();
  redis.values.set(KEY, '5');
  const f = service(redis.handle);
  try {
    f.state.row = { state: 'normal', reason_category: null, row_version: 4 };
    expect((await f.risk.readRiskState(SUBJECT)).state).toBe('normal');
    expect((await f.risk.readRiskState(SUBJECT)).state).toBe('normal');
    // Not cached: both reads went to the database; the stamp stays at the remote version.
    expect(f.reads()).toBe(2);
    expect(redis.values.get(KEY)).toBe('5');
    // The remote write becomes visible: from then on it is cached.
    f.state.row = { state: 'banned', reason_category: 'other', row_version: 5 };
    expect((await f.risk.readRiskState(SUBJECT)).state).toBe('banned');
    expect((await f.risk.readRiskState(SUBJECT)).state).toBe('banned');
    expect(f.reads()).toBe(3);
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] a fill writes its baseline (no row = -1) with the stamp TTL, then hits are confirmed by GET', async () => {
  const redis = memoryRedis();
  const f = service(redis.handle);
  try {
    await f.risk.readRiskState(SUBJECT);
    expect(redis.namespaces).toContain(RISK_STATE_STAMP_NAMESPACE);
    expect(redis.evals).toHaveBeenCalledTimes(1);
    expect(redis.evals.mock.calls[0]![1]).toEqual({
      keys: [KEY],
      args: ['-1'],
      ttlSeconds: STAMP_TTL_SECONDS,
    });
    expect(STAMP_TTL_SECONDS).toBeGreaterThanOrEqual(120);
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(1);
    expect(redis.gets).toHaveBeenCalledWith(KEY);
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] a hit whose stamp is missing, higher, unreadable or failing reads the database', async () => {
  const redis = memoryRedis();
  const f = service(redis.handle);
  try {
    f.state.row = { state: 'normal', reason_category: null, row_version: 2 };
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(1);
    redis.values.delete(KEY);
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(2);
    redis.values.set(KEY, '3');
    f.state.row = { state: 'banned', reason_category: 'other', row_version: 3 };
    expect((await f.risk.readRiskState(SUBJECT)).state).toBe('banned');
    expect(f.reads()).toBe(3);
    redis.values.set(KEY, 'garbage');
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(4);
    redis.failures.get = true;
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(5);
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] a failed baseline write leaves the value uncached', async () => {
  const redis = memoryRedis();
  redis.failures.eval = true;
  const f = service(redis.handle);
  try {
    await f.risk.readRiskState(SUBJECT);
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(2);
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] setRiskState stamps the version it writes before publishing; a failed stamp rejects', async () => {
  const redis = memoryRedis();
  const f = service(redis.handle);
  try {
    f.state.row = { state: 'normal', reason_category: null, row_version: 6 };
    await f.db.transaction().execute((trx) => f.risk.setRiskState(trx, BAN));
    expect(redis.values.get(KEY)).toBe('7');
    redis.failures.eval = true;
    const before = f.publish.mock.calls.length;
    await expect(
      f.db.transaction().execute((trx) => f.risk.setRiskState(trx, BAN)),
    ).rejects.toThrow('synthetic eval failure');
    expect(f.publish.mock.calls.length).toBe(before);
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] without Redis the process cache works alone (no stamp reads or writes)', async () => {
  const f = service();
  try {
    await f.risk.readRiskState(SUBJECT);
    await f.risk.readRiskState(SUBJECT);
    expect(f.reads()).toBe(1);
  } finally {
    await f.db.destroy();
  }
});

it.each([
  [null, 0],
  [3, null],
  [4, 3],
] as const)(
  '[F1-07d] expected_row_version=%s against row %s conflicts before any write',
  async (expected, actual) => {
    const f = service();
    try {
      f.state.row =
        actual === null ? null : { state: 'normal', reason_category: null, row_version: actual };
      await expect(
        f.db
          .transaction()
          .execute((trx) => f.risk.setRiskState(trx, { ...BAN, expected_row_version: expected })),
      ).rejects.toBeInstanceOf(RiskStateConflictError);
      expect(f.statements.some((s) => /^(insert|update)\b/i.test(s))).toBe(false);
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      await f.db.destroy();
    }
  },
);

it('[F1-07d] a first row lost to a concurrent insert is a conflict under the compare-and-set only', async () => {
  const f = service();
  try {
    f.state.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(
      f.db
        .transaction()
        .execute((trx) => f.risk.setRiskState(trx, { ...BAN, expected_row_version: null })),
    ).rejects.toBeInstanceOf(RiskStateConflictError);
    await expect(
      f.db.transaction().execute((trx) => f.risk.setRiskState(trx, BAN)),
    ).rejects.toThrow('duplicate key');
  } finally {
    await f.db.destroy();
  }
});

it('[F1-07d] raiseRiskStateStamp returns the stamp after the write and refuses a non-version answer', async () => {
  const redis = memoryRedis();
  redis.values.set(KEY, '9');
  expect(await raiseRiskStateStamp(redis.handle, SUBJECT, 4)).toBe(9);
  expect(await raiseRiskStateStamp(redis.handle, SUBJECT, 11)).toBe(11);
  redis.evals.mockResolvedValueOnce('not-a-number');
  await expect(raiseRiskStateStamp(redis.handle, SUBJECT, 12)).rejects.toThrow(/not a version/);
});

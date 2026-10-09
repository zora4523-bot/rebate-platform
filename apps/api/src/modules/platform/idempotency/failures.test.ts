import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import {
  COMPLETION_ATTEMPTS,
  COMPLETION_DEADLINE_MS,
  IdempotencyError,
  MAX_CANONICAL_DEPTH,
  canonicalJson,
  createIdempotency,
  isNestingTooDeep,
  requestHashOf,
  type IdempotentRequest,
} from './index.ts';

const request: IdempotentRequest = {
  appId: 'couli',
  actor: { userId: '0199a3b4-5c6d-7e8f-9a0b-000000000001', deviceId: null, phoneHmac: null },
  method: 'POST',
  path: '/v1/withdrawals',
  key: 'unit-key',
  body: {},
  traceId: 'unit-trace',
};

// A scripted driver exercises Kysely's actual transaction wrapper without connecting to PG.
// Database concurrency and uniqueness are tested separately by the externally authored suite.
function fixture(failAt: 'record' | 'commit' | 'claim' | 'none') {
  const error = Object.assign(new Error('driver failure'), { code: '55P03' });
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    release,
    async query(text: string) {
      statements.push(text);
      if (
        (failAt === 'record' && text.startsWith('update')) ||
        (failAt === 'commit' && text === 'commit') ||
        (failAt === 'claim' && text.startsWith('insert'))
      )
        throw error;
      let rows: unknown[] = [];
      if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('insert')) rows = [{ id: 1n }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const idem = createIdempotency({
    db,
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: { warn: vi.fn() },
  });
  return { db, idem, error, statements, release };
}

it('[AC-B1-01i#1] only a failed COMMIT is classified as outcome_unknown; record-write failures keep the driver error', async () => {
  for (const phase of ['record', 'commit'] as const) {
    const f = fixture(phase);
    try {
      const call = f.idem.executeInTransaction(request, async () => ({
        status: 200,
        envelope: { code: 0, msg: '', trace_id: 'unit-trace' },
      }));
      if (phase === 'commit') await expect(call).rejects.toMatchObject({ code: 'outcome_unknown' });
      else await expect(call).rejects.toBe(f.error);
      expect(f.statements.includes('commit')).toBe(phase === 'commit');
      expect(f.statements.at(-1)).toBe('rollback');
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.destroy();
    }
  }
});

it('[AC-B1-01i#2] lock timeout becomes 40901 only during key acquisition; a handler lock failure remains its original error', async () => {
  for (const phase of ['claim', 'none'] as const) {
    const f = fixture(phase);
    const handler = vi.fn(async () => {
      throw f.error;
    });
    try {
      const call = f.idem.executeInTransaction(request, handler);
      if (phase === 'claim') {
        const response = await call;
        expect(JSON.parse(response.body)).toMatchObject({ code: 40901 });
        expect(handler).not.toHaveBeenCalled();
      } else {
        await expect(call).rejects.toBe(f.error);
        expect(handler).toHaveBeenCalledTimes(1);
      }
      expect(f.statements).not.toContain('commit');
      expect(f.statements.at(-1)).toBe('rollback');
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.destroy();
    }
  }
});

type LogFn = (fields: Readonly<Record<string, unknown>>, msg: string) => void;

// Standard mode: a scripted driver whose `completed` writes fail a given number of times (B1-01zh).
function standardFixture(options: {
  updateFailures: number;
  updateRows?: () => unknown[];
  warnOnly?: boolean;
  /** Every `completed` write hangs until the test settles it through `hung`. */
  hang?: boolean;
}) {
  const error = Object.assign(new Error('driver failure std-secret-key'), { code: '08006' });
  const statements: string[] = [];
  let failures = options.updateFailures;
  const hung: { resolve: (rows: unknown[]) => void; reject: (error: unknown) => void }[] = [];
  const client = {
    release: vi.fn(),
    async query(text: string) {
      statements.push(text);
      let rows: unknown[] = [];
      if (text.startsWith('update') && options.hang === true) {
        rows = await new Promise<unknown[]>((resolve, reject) => {
          hung.push({ resolve, reject });
        });
      } else if (text.startsWith('update')) {
        if (failures > 0) {
          failures -= 1;
          throw error;
        }
        rows = options.updateRows?.() ?? [{ id: 1n }];
      } else if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('insert'))
        rows = [{ id: 1n, ownership_created_at: '2031-01-01 00:00:00+00' }];
      else if (text.startsWith('delete')) rows = [{ id: 1n }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
  const idem = createIdempotency({
    db,
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: options.warnOnly === true ? { warn: logger.warn } : logger,
  });
  const updates = () => statements.filter((text) => text.startsWith('update')).length;
  const deletes = () => statements.filter((text) => text.startsWith('delete')).length;
  return { db, idem, logger, updates, deletes, hung, statements };
}

const standardRequest: IdempotentRequest = {
  ...request,
  path: '/v1/links/std-link/open',
  key: 'std-secret-key',
  body: { secret: 'std-secret-body' },
};
const stored = { status: 201, envelope: { code: 0, msg: '', trace_id: 'unit-trace' } };

it('[AC-B1-01zh#1] a failed completed write is retried and the handler response is returned', async () => {
  const f = standardFixture({ updateFailures: 1 });
  const handler = vi.fn(async () => stored);
  try {
    await expect(f.idem.execute(standardRequest, handler)).resolves.toStrictEqual({
      status: 201,
      body: JSON.stringify(stored.envelope),
      source: 'handler',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.updates()).toBe(2);
    expect(f.deletes()).toBe(0);
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zh#2] completed writes failing every time end in outcome_unknown, the row kept, one redacted error line', async () => {
  const f = standardFixture({ updateFailures: Infinity });
  const handler = vi.fn(async () => stored);
  try {
    await expect(f.idem.execute(standardRequest, handler)).rejects.toMatchObject({
      name: 'IdempotencyError',
      code: 'outcome_unknown',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.updates()).toBe(COMPLETION_ATTEMPTS);
    expect(f.deletes()).toBe(0);
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/links/std-link/open', attempts: COMPLETION_ATTEMPTS },
      'idempotency_completion_unknown',
    );
    const logged = JSON.stringify(f.logger.error.mock.calls);
    for (const secret of ['std-secret-key', 'std-secret-body', 'driver failure'])
      expect(logged).not.toContain(secret);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zh#2] a logger without error reports the unknown completion through warn', async () => {
  const f = standardFixture({ updateFailures: Infinity, warnOnly: true });
  const warn = f.logger.warn;
  try {
    await expect(f.idem.execute(standardRequest, async () => stored)).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/links/std-link/open', attempts: COMPLETION_ATTEMPTS },
      'idempotency_completion_unknown',
    );
    expect(f.logger.error).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zh#1] a retry that finds the row taken over writes nothing and logs idempotency_record_lost', async () => {
  const f = standardFixture({ updateFailures: 1, updateRows: () => [] });
  try {
    await expect(f.idem.execute(standardRequest, async () => stored)).resolves.toMatchObject({
      status: 201,
      source: 'handler',
    });
    expect(f.updates()).toBe(2);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/links/std-link/open' },
      'idempotency_record_lost',
    );
    expect(f.logger.error).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zh#3] a thrown or unstored handler still deletes the row without any completed write', async () => {
  const f = standardFixture({ updateFailures: Infinity });
  const thrown = new Error('handler failed');
  try {
    await expect(
      f.idem.execute(standardRequest, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await expect(
      f.idem.execute(standardRequest, async () => ({
        status: 403,
        envelope: { code: 10003, msg: 'no', trace_id: 'unit-trace' },
      })),
    ).resolves.toMatchObject({ status: 403, source: 'handler' });
    expect(f.updates()).toBe(0);
    expect(f.deletes()).toBe(2);
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

// A write that never answers (network gone, TCP silent): the deadline ends the request.
async function hangingCompletion(
  settle: (pending: {
    resolve: (rows: unknown[]) => void;
    reject: (error: unknown) => void;
  }) => void,
) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = standardFixture({ updateFailures: 0, hang: true });
  const handler = vi.fn(async () => stored);
  try {
    let outcome: unknown = 'pending';
    const call = f.idem.execute(standardRequest, handler).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(COMPLETION_DEADLINE_MS - 1);
    expect(outcome).toBe('pending');
    expect(f.updates()).toBe(1);
    expect(f.hung).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(outcome).toMatchObject({ name: 'IdempotencyError', code: 'outcome_unknown' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/links/std-link/open', attempts: 1 },
      'idempotency_completion_unknown',
    );
    // The abandoned write settles later: nothing more is written, logged or left unhandled.
    const before = f.statements.length;
    settle(f.hung[0]!);
    await vi.advanceTimersByTimeAsync(COMPLETION_DEADLINE_MS);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(f.statements.length).toBe(before);
    expect(f.updates()).toBe(1);
    expect(f.deletes()).toBe(0);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(unhandled).toStrictEqual([]);
  } finally {
    vi.useRealTimers();
    process.off('unhandledRejection', onUnhandled);
    await f.db.destroy();
  }
}

it('[AC-B1-01zh#2] a completed write that never answers ends in outcome_unknown at the deadline; its late rejection is swallowed', async () => {
  await hangingCompletion((pending) => {
    pending.reject(Object.assign(new Error('driver failure std-secret-key'), { code: '08006' }));
  });
});

it('[AC-B1-01zh#2] an abandoned completed write that succeeds late logs nothing more and starts no retry', async () => {
  await hangingCompletion((pending) => {
    pending.resolve([]);
  });
});

// B1-01zt: a scripted driver whose advisory lock is held by someone else, or whose delete / COMMIT
// fails, to check contention replay, cleanup failure and commit-unknown logging without PG.
function followupFixture(options: {
  lockHeld?: boolean;
  row?: Record<string, unknown> | undefined;
  failDelete?: boolean;
  failCommit?: boolean;
}) {
  const error = Object.assign(new Error('driver failure fu-secret-key fu-secret-body'), {
    code: '08006',
  });
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    release,
    async query(text: string) {
      statements.push(text);
      if (options.failDelete === true && text.startsWith('delete')) throw error;
      if (options.failCommit === true && text === 'commit') throw error;
      let rows: unknown[] = [];
      if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: !options.lockHeld }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('select') && options.row !== undefined) rows = [options.row];
      else if (text.startsWith('insert'))
        rows = [{ id: 1n, ownership_created_at: '2031-01-01 00:00:00+00' }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
  const idem = createIdempotency({ db, clock: new FixedClock('2031-01-01T00:00:00Z'), logger });
  return { db, idem, logger, statements, release, error };
}

const fuRequest: IdempotentRequest = {
  ...request,
  path: '/v1/links/fu-link/open',
  key: 'fu-secret-key',
  body: { secret: 'fu-secret-body' },
};
const storedBody = '{"code":0,"msg":"","data":{"n":1},"trace_id":"first-trace"}';

it('[AC-B1-01zt#1] with the key lock held, a completed record of the same hash replays and anything else is 40901', async () => {
  for (const mode of ['execute', 'executeInTransaction'] as const) {
    const req = mode === 'execute' ? fuRequest : { ...fuRequest, path: '/v1/withdrawals' };
    const completed = {
      id: 1n,
      status: 'completed',
      request_hash: requestHashOf(req.body),
      response: { status: 201, body: storedBody },
      ownership_created_at: '2031-01-01 00:00:00+00',
    };
    const cases = [
      [completed, { status: 201, body: storedBody, source: 'replay' }],
      [{ ...completed, request_hash: 'f'.repeat(64) }, 40901],
      [{ ...completed, status: 'processing', response: null }, 40901],
      [{ ...completed, status: 'abandoned', request_hash: null, response: null }, 40901],
      [undefined, 40901],
    ] as const;
    for (const [row, expected] of cases) {
      const f = followupFixture({ lockHeld: true, row });
      const handler = vi.fn(async () => stored);
      try {
        const response = await f.idem[mode](req, handler);
        if (expected === 40901) {
          expect(response.status).toBe(409);
          expect(JSON.parse(response.body)).toMatchObject({ code: 40901, trace_id: 'unit-trace' });
        } else expect(response).toStrictEqual(expected);
        expect(handler).not.toHaveBeenCalled();
        // One connection, no write, no lock wait: the read happens in the lock's transaction.
        expect(f.release).toHaveBeenCalledTimes(1);
        expect(f.statements.some((text) => /^(insert|update|delete)/.test(text))).toBe(false);
        expect(f.statements.some((text) => text.includes('lock_timeout'))).toBe(false);
      } finally {
        await f.db.destroy();
      }
    }
  }
});

it('[AC-B1-01zt#3] a thrown handler whose cleanup delete fails rethrows its own error and logs one redacted line', async () => {
  const f = followupFixture({ failDelete: true });
  const thrown = new Error('handler failed');
  try {
    await expect(
      f.idem.execute(fuRequest, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/links/fu-link/open' },
      'idempotency_cleanup_failed',
    );
    expect(f.logger.warn).not.toHaveBeenCalled();
    // An unstored result keeps the driver error (unchanged behaviour).
    await expect(
      f.idem.execute(fuRequest, async () => ({
        status: 403,
        envelope: { code: 10003, msg: 'no', trace_id: 'unit-trace' },
      })),
    ).rejects.toBe(f.error);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zt#4] an unknown COMMIT outcome logs one error line with method and path only', async () => {
  const f = followupFixture({ failCommit: true });
  try {
    await expect(
      f.idem.executeInTransaction({ ...fuRequest, path: '/v1/withdrawals' }, async () => stored),
    ).rejects.toMatchObject({ name: 'IdempotencyError', code: 'outcome_unknown' });
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/withdrawals' },
      'idempotency_commit_unknown',
    );
    expect(f.logger.warn).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zt#2] nesting up to the limit is hashed; one level more is a marked invalid_request', () => {
  const nested = (depth: number) => JSON.parse('['.repeat(depth) + ']'.repeat(depth)) as unknown;
  const deepest = nested(MAX_CANONICAL_DEPTH);
  expect(canonicalJson(deepest)).toBe(
    '['.repeat(MAX_CANONICAL_DEPTH) + ']'.repeat(MAX_CANONICAL_DEPTH),
  );
  let caught: unknown;
  try {
    canonicalJson({ a: nested(MAX_CANONICAL_DEPTH) });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IdempotencyError);
  expect(caught).toMatchObject({ code: 'invalid_request' });
  expect(Reflect.ownKeys(caught as object).sort()).toEqual(['code', 'message', 'name', 'stack']);
  expect(isNestingTooDeep(caught)).toBe(true);
  expect(isNestingTooDeep(new IdempotencyError('invalid_request'))).toBe(false);
  let other: unknown;
  try {
    canonicalJson({ a: Number.NaN });
  } catch (error) {
    other = error;
  }
  expect(isNestingTooDeep(other)).toBe(false);
  expect(isNestingTooDeep(null)).toBe(false);
});

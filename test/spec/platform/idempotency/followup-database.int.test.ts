// B1-01zt 台账①③④。沿用 transaction-failures / completion-failure 的 pg 层注入，
// 不替换业务实现；所有状态由独立连接读取真实数据库核对。
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, PostgresPool } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createIdempotency,
  IdempotencyError,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  RESPONSES,
  businessCount,
  businessWrite,
  freshKey,
  gate,
  recordingLogger,
  request,
  result,
  rowsOf,
  sensitiveRequest,
  within,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';
const BODY_MARKER = 'followup-private-body';
const DRIVER_MARKER = 'followup-private-driver-detail';
const HANDLER_MARKER = 'followup-private-handler-error';

interface PgClientLike {
  query(text: unknown, params?: unknown): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface Fault {
  kind: 'delete' | 'commit-ack';
  error: Error;
  fired: number;
}
interface CommitPause {
  entered: ReturnType<typeof gate>;
  release: ReturnType<typeof gate>;
  reached: boolean;
}

const requireFromDb = createRequire(
  new URL('../../../../packages/db/package.json', import.meta.url),
);
const pg = requireFromDb('pg') as { Pool: new (config: unknown) => PgPoolLike };
let database: TestDatabase;
let db: Kysely<DB>;
let observer: Kysely<DB>;
let activeFault: Fault | undefined;
let nextCommit: CommitPause | undefined;

function wrapClient(client: PgClientLike): PgClientLike {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: unknown, params?: unknown) => {
          const statement = typeof text === 'string' ? text.trim().toLowerCase() : '';
          const fault = activeFault;
          if (
            fault?.kind === 'delete' &&
            /^delete\b/.test(statement) &&
            statement.includes('idempotency_keys')
          ) {
            fault.fired += 1;
            // 持续失败，不因可能的清理重试而偶然成功。
            throw fault.error;
          }
          if (statement === 'commit') {
            if (fault?.kind === 'commit-ack' && fault.fired === 0) {
              await target.query(text, params);
              fault.fired += 1;
              throw fault.error;
            }
            const pause = nextCommit;
            if (pause !== undefined) {
              nextCommit = undefined;
              pause.reached = true;
              pause.entered.open();
              // 只暂停第一个回放事务的 COMMIT，真实 advisory lock 仍被占用。
              await pause.release.promise;
            }
          }
          return target.query(text, params);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function wrappedPool(config: unknown): PostgresPool {
  const real = new pg.Pool(config);
  real.on('error', () => undefined);
  const clients = new WeakMap<PgClientLike, PgClientLike>();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          let wrapped = clients.get(client);
          if (wrapped === undefined) {
            client.on('error', () => undefined);
            wrapped = wrapClient(client);
            clients.set(client, wrapped);
          }
          return wrapped;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as PostgresPool;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.urlFor('couli_app');
  db = createDb({
    max: 12,
    poolFactory: (config) => wrappedPool({ ...config, connectionString: url }),
  });
  observer = createDb({ connectionString: url, max: 2 });
}, 60_000);

afterAll(async () => {
  activeFault = undefined;
  nextCommit?.release.open();
  nextCommit = undefined;
  try {
    if (db !== undefined) await within(destroyDb(db), 5000);
    if (observer !== undefined) await within(destroyDb(observer), 5000);
  } finally {
    await database?.drop();
  }
}, 30_000);

function setup() {
  const { logger, calls } = recordingLogger();
  return { idem: createIdempotency({ db, clock: new FixedClock(T0), logger }), calls };
}

async function settle(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

function arm(kind: Fault['kind'], key: string): Fault {
  const fault = {
    kind,
    fired: 0,
    error: Object.assign(new Error(`${DRIVER_MARKER} ${BODY_MARKER} ${key}`), {
      code: '08006',
      detail: { body: BODY_MARKER, key },
    }),
  };
  activeFault = fault;
  return fault;
}

it.each(['execute', 'executeInTransaction'] as const)(
  '[AC-B1-01zt#1] %s 已完成键的八个重放全部返回原响应；锁竞争时不同哈希仍拒绝',
  async (mode) => {
    const { idem } = setup();
    const req = mode === 'execute' ? request() : sensitiveRequest('withdraw');
    const output = result(0, 201, { receipt: 'original-result', order: ['b', 'a'] });
    const handler = vi.fn(async () => output);
    const original = await idem[mode](req, handler);
    expect(original).toStrictEqual({
      status: 201,
      body: JSON.stringify(output.envelope),
      source: 'handler',
    });
    const before = await rowsOf(observer, req.key!);
    const pause: CommitPause = { entered: gate(), release: gate(), reached: false };
    nextCommit = pause;
    const replayRequest = { ...req, traceId: 'followup-new-trace' };
    const first = settle(() => idem[mode](replayRequest, handler));
    let others: Awaited<ReturnType<typeof settle>>[] | 'timeout' = [];
    let mismatched: Awaited<ReturnType<typeof settle>>[] | 'timeout' = [];
    try {
      await Promise.race([pause.entered.promise, first]);
      expect(pause.reached).toBe(true);
      // 第一份回放仍在事务中，另外七份真正并发请求；无需 sleep 或碰运气。
      others = await within(
        Promise.all(
          Array.from({ length: 7 }, () => settle(() => idem[mode](replayRequest, handler))),
        ),
        15_000,
      );
      mismatched = await within(
        Promise.all(
          Array.from({ length: 8 }, () =>
            settle(() => idem[mode]({ ...req, body: { changed: true } }, handler)),
          ),
        ),
        15_000,
      );
    } finally {
      nextCommit = undefined;
      pause.release.open();
      await first;
    }
    expect
      .soft(others)
      .toStrictEqual(
        Array.from({ length: 7 }, () => ({ value: { ...original, source: 'replay' } })),
      );
    expect(await first).toStrictEqual({ value: { ...original, source: 'replay' } });
    // 台账规定：拿不到锁且不是同哈希 completed，保持 40901。
    expect(mismatched).toStrictEqual(
      Array.from({ length: 8 }, () => ({ value: RESPONSES.e40901 })),
    );
    // 无锁竞争时，不同哈希继续采用原有的 20901。
    expect(await idem[mode]({ ...req, body: { changed: true } }, handler)).toStrictEqual(
      RESPONSES.e20901,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await rowsOf(observer, req.key!)).toStrictEqual(before);
  },
  60_000,
);

it('[AC-B1-01zt#3] 处理异常且删行失败：保留原错误对象，记录一行脱敏日志，不重跑处理函数', async () => {
  const { idem, calls } = setup();
  const key = freshKey('cleanup');
  const req = request({ key, body: { private: BODY_MARKER } });
  const originalError = new Error(`${HANDLER_MARKER} ${BODY_MARKER} ${key}`);
  let fault: Fault | undefined;
  let before: Awaited<ReturnType<typeof rowsOf>> = [];
  const handler = vi.fn(async () => {
    before = await rowsOf(observer, key);
    fault = arm('delete', key);
    throw originalError;
  });
  try {
    const completed = await settle(() => idem.execute(req, handler));
    expect(fault?.fired).toBeGreaterThanOrEqual(1);
    expect.soft(completed.error).toBe(originalError);
    expect.soft(calls).toHaveLength(1);
    const logged = inspect(calls, { depth: null });
    for (const secret of [BODY_MARKER, key]) {
      expect(logged).not.toContain(secret);
    }
    expect(before).toHaveLength(1);
    expect(before[0]?.status).toBe('processing');
    expect(await rowsOf(observer, key)).toStrictEqual(before);
    expect(await idem.execute(req, handler)).toStrictEqual(RESPONSES.e40901);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    activeFault = undefined;
  }
}, 60_000);

it('[AC-B1-01zt#4] 事务已提交但确认丢失：outcome_unknown、一行脱敏 error，原键可恢复原响应', async () => {
  const { idem, calls } = setup();
  const key = freshKey('commit_unknown');
  const req = sensitiveRequest('withdraw', { key, body: { private: BODY_MARKER } });
  const output = result(0, 201, { receipt: 'committed' });
  let fault: Fault | undefined;
  const handler = vi.fn(async (trx: Kysely<DB>) => {
    await businessWrite(trx, key, 1);
    fault = arm('commit-ack', key);
    return output;
  });
  try {
    const completed = await settle(() => idem.executeInTransaction(req, handler));
    expect(fault?.fired).toBe(1);
    expect(completed.error).toBeInstanceOf(IdempotencyError);
    expect(completed.error).toMatchObject({ code: 'outcome_unknown' });
    expect.soft(calls).toHaveLength(1);
    expect.soft(calls[0]).toMatchObject({
      method: 'error',
      args: [expect.objectContaining({ method: req.method, path: req.path }), expect.any(String)],
    });
    const logged = inspect(calls, { depth: null });
    for (const secret of [BODY_MARKER, DRIVER_MARKER, key]) {
      expect(logged).not.toContain(secret);
    }
    expect(inspect(completed.error, { depth: null })).not.toContain(DRIVER_MARKER);
    expect(await businessCount(observer, key)).toBe(1);
    const before = await rowsOf(observer, key);
    expect(before.map((row) => row.status)).toEqual(['completed']);
    expect(await idem.executeInTransaction(req, handler)).toStrictEqual({
      status: 201,
      body: JSON.stringify(output.envelope),
      source: 'replay',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await rowsOf(observer, key)).toStrictEqual(before);
    expect(await businessCount(observer, key)).toBe(1);
    expect.soft(calls).toHaveLength(1);
  } finally {
    activeFault = undefined;
  }
}, 60_000);

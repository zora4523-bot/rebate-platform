// B1-01zh 台账与编排者补充：只约束标准模式在处理函数返回后的 completed 写入。
// 沿用 transaction-failures.int.test.ts 的 pg 包装方式；故障只在处理函数中开启，
// 在 SQL 到达数据库前抛出，独立 observer 检查真实提交状态与业务效果。
// 租约到期后的接管不在本任务内；事务模式也不能原子保护库外的计费调用。
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
  recordingLogger,
  request,
  result,
  sensitiveRequest,
  sha256Hex,
  within,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';
// 宽松的测试完成期限，不规定实现的重试次数或退避间隔；小于默认 60 秒租约。
const FINISH_DEADLINE_MS = 15_000;
const REQUEST_MARKER = 'completion-private-request';
const RESPONSE_MARKER = 'completion-private-response';

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
  remaining: number;
  attempts: number;
  error: Error;
  commitAck: boolean;
}

const requireFromDb = createRequire(
  new URL('../../../../packages/db/package.json', import.meta.url),
);
const pg = requireFromDb('pg') as { Pool: new (config: unknown) => PgPoolLike };
let database: TestDatabase;
let faulty: Kysely<DB>;
let observer: Kysely<DB>;
let activeFault: Fault | undefined;

function isCompletedWrite(text: string, params: unknown): boolean {
  const statement = text.trim().toLowerCase();
  return (
    /^(insert|update)\b/.test(statement) &&
    statement.includes('idempotency_keys') &&
    (statement.includes("'completed'") || (Array.isArray(params) && params.includes('completed')))
  );
}

function faultyClient(client: PgClientLike): PgClientLike {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: unknown, params?: unknown) => {
          const fault = activeFault;
          if (fault !== undefined && typeof text === 'string') {
            if (isCompletedWrite(text, params)) {
              fault.attempts += 1;
              if (fault.remaining > 0) {
                fault.remaining -= 1;
                throw fault.error;
              }
            }
            if (fault.commitAck && text.trim().toLowerCase() === 'commit') {
              fault.commitAck = false;
              await target.query(text, params);
              throw fault.error;
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

function faultyPool(config: unknown): PostgresPool {
  const real = new pg.Pool(config);
  real.on('error', () => undefined);
  const wrapped = new WeakMap<PgClientLike, PgClientLike>();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          let proxy = wrapped.get(client);
          if (proxy === undefined) {
            client.on('error', () => undefined);
            proxy = faultyClient(client);
            wrapped.set(client, proxy);
          }
          return proxy;
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
  faulty = createDb({
    max: 4,
    poolFactory: (config) => faultyPool({ ...config, connectionString: url }),
  });
  observer = createDb({ connectionString: url, max: 2 });
});

afterAll(async () => {
  activeFault = undefined;
  try {
    await within(destroyDb(faulty), 5000);
    await within(destroyDb(observer), 5000);
  } finally {
    await database.drop();
  }
});

function setup() {
  const { logger, calls } = recordingLogger();
  const idem = createIdempotency({ db: faulty, clock: new FixedClock(T0), logger });
  return { idem, calls };
}

function arm(remaining: number, code: string, key: string): Fault {
  const fault: Fault = {
    remaining,
    attempts: 0,
    // PG 的错误 detail 或 message 可能带参数；日志不能间接泄露这些值。
    error: Object.assign(new Error(`${REQUEST_MARKER} ${key} ${RESPONSE_MARKER}`), {
      code,
      detail: { request: REQUEST_MARKER, key, response: RESPONSE_MARKER },
    }),
    commitAck: false,
  };
  activeFault = fault;
  return fault;
}

function rows(key: string) {
  return observer.selectFrom('idempotency_keys').selectAll().where('key', '=', key).execute();
}

async function settle(call: () => Promise<unknown>) {
  try {
    return { value: await call() };
  } catch (error) {
    return { error };
  }
}

it.each([
  { code: 0, status: 201, driverCode: '08006' },
  { code: 30001, status: 422, driverCode: '40001' },
])(
  '[AC-B1-01zh#1] 可存储结果 $code：第一次 completed 写失败，第二次成功，原响应与业务效果只产生一次',
  async ({ code, status, driverCode }) => {
    const { idem } = setup();
    const key = freshKey('completion');
    const req = request({ key });
    const output = result(code, status, { receipt: RESPONSE_MARKER });
    let fault: Fault | undefined;
    const handler = vi.fn(async () => {
      await businessWrite(observer, key, 1);
      fault = arm(1, driverCode, key);
      return output;
    });
    try {
      const completed = await within(
        settle(() => idem.execute(req, handler)),
        FINISH_DEADLINE_MS,
      );
      expect(completed).toStrictEqual({
        value: { status, body: JSON.stringify(output.envelope), source: 'handler' },
      });
      expect(fault?.attempts).toBe(2);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await businessCount(observer, key)).toBe(1);
      const stored = await rows(key);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        status: 'completed',
        request_hash: sha256Hex('{"installed":"unknown","no_rebate":false}'),
        response: { status, body: JSON.stringify(output.envelope) },
      });
      expect(await idem.execute(req, handler)).toStrictEqual({
        status,
        body: JSON.stringify(output.envelope),
        source: 'replay',
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await businessCount(observer, key)).toBe(1);
    } finally {
      activeFault = undefined;
    }
  },
  60_000,
);

it('[AC-B1-01zh#2] 持续失败有界结束为 outcome_unknown，processing 整行不变，仅一行脱敏 error 日志', async () => {
  const { idem, calls } = setup();
  const key = freshKey('private_completion');
  const req = request({ key, body: { secret: REQUEST_MARKER } });
  let before: Awaited<ReturnType<typeof rows>> = [];
  let fault: Fault | undefined;
  const handler = vi.fn(async () => {
    await businessWrite(observer, key, 1);
    before = await rows(key);
    fault = arm(Infinity, '08006', key);
    return result(0, 200, { receipt: RESPONSE_MARKER });
  });
  try {
    const completed = await within(
      settle(() => idem.execute(req, handler)),
      FINISH_DEADLINE_MS,
    );
    // 把错误作为数据断言：旧实现会因错误类型不符先红，而非未捕获驱动错误。
    expect(completed).toEqual({ error: expect.any(IdempotencyError) });
    expect(completed).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(fault?.attempts).toBeGreaterThanOrEqual(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      status: 'processing',
      request_hash: sha256Hex(JSON.stringify(req.body)),
      response: null,
    });
    expect(await rows(key)).toStrictEqual(before);
    expect(await businessCount(observer, key)).toBe(1);
    // 租约仍有效：原键继续得到处理中，不能立刻重新执行已经生效的处理函数。
    expect(await idem.execute(req, handler)).toStrictEqual(RESPONSES.e40901);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await rows(key)).toStrictEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'error' });
    // inspect 连 Error 的非枚举 message/stack 也检查，避免 JSON.stringify 漏检。
    const logged = inspect(calls, { depth: null });
    for (const secret of [REQUEST_MARKER, RESPONSE_MARKER, key, JSON.stringify(req.body)]) {
      expect(logged).not.toContain(secret);
    }
  } finally {
    activeFault = undefined;
  }
}, 60_000);

it('[AC-B1-01zh#3] 故障处理按阶段隔离：处理异常和不存储仍删行，事务仍回滚或报告提交未知，仅标准 completed 重试', async () => {
  const { idem } = setup();
  const thrown = new Error('handler failed before returning a result');
  const thrownKey = freshKey();
  const discardedKey = freshKey();
  const transactionalKey = freshKey();
  const committedKey = freshKey();
  const standardKey = freshKey();
  const output = result(0, 200);
  const discarded = result(10003, 403);
  try {
    const thrownOutcome = await settle(() =>
      idem.execute(request({ key: thrownKey }), async () => {
        arm(Infinity, '08006', thrownKey);
        throw thrown;
      }),
    );
    expect(thrownOutcome).toEqual({ error: thrown });
    expect(await rows(thrownKey)).toEqual([]);
    expect(activeFault?.attempts).toBe(0);
    const discardedOutcome = await idem.execute(request({ key: discardedKey }), async () => {
      arm(Infinity, '08006', discardedKey);
      return discarded;
    });
    expect(discardedOutcome).toStrictEqual({
      status: 403,
      body: JSON.stringify(discarded.envelope),
      source: 'handler',
    });
    expect(await rows(discardedKey)).toEqual([]);
    expect(activeFault?.attempts).toBe(0);

    const transactionalHandler = vi.fn(async (trx: Kysely<DB>) => {
      await businessWrite(trx, transactionalKey, 1);
      arm(1, '08006', transactionalKey);
      return output;
    });
    const transactionOutcome = await settle(() =>
      idem.executeInTransaction(
        sensitiveRequest('withdraw', { key: transactionalKey }),
        transactionalHandler,
      ),
    );
    expect(transactionOutcome).toEqual({ error: activeFault?.error });
    expect(activeFault?.attempts).toBe(1);
    expect(transactionalHandler).toHaveBeenCalledTimes(1);
    expect(await rows(transactionalKey)).toEqual([]);
    expect(await businessCount(observer, transactionalKey)).toBe(0);

    const commitOutcome = await settle(() =>
      idem.executeInTransaction(
        sensitiveRequest('withdraw', { key: committedKey }),
        async (trx) => {
          await businessWrite(trx, committedKey, 1);
          arm(0, '08006', committedKey).commitAck = true;
          return output;
        },
      ),
    );
    expect(commitOutcome).toEqual({ error: expect.any(IdempotencyError) });
    expect(commitOutcome).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(await businessCount(observer, committedKey)).toBe(1);
    expect((await rows(committedKey)).map((row) => row.status)).toEqual(['completed']);

    const standardHandler = vi.fn(async () => {
      arm(1, '08006', standardKey);
      return output;
    });
    const standardOutcome = await within(
      settle(() => idem.execute(request({ key: standardKey }), standardHandler)),
      FINISH_DEADLINE_MS,
    );
    expect(standardOutcome).toStrictEqual({
      value: { status: 200, body: JSON.stringify(output.envelope), source: 'handler' },
    });
    expect(standardHandler).toHaveBeenCalledTimes(1);
    expect(activeFault?.attempts).toBe(2);
  } finally {
    activeFault = undefined;
  }
}, 60_000);

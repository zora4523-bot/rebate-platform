// Rule tests for failures inside the transaction of the four sensitive operations (08 BR-ID-10
// 细则「敏感操作的幂等键」之「服务端的配合」「作废与业务结果互斥」; BR-WDR-07 ⑧; 规划/04 §3.2
// idempotency_keys 行, §5「幂等」; contract section 4 (transactional mode: "A failure before
// COMMIT rolls back and rejects with the driver's error"; "The commit itself fails (outcome
// unknown) → reject with IdempotencyError('outcome_unknown')") of
// apps/api/src/modules/platform/idempotency/index.ts). Added after spec review round 1.
//
// Faults are injected deterministically below the module, in the pg client the Kysely instance
// uses (createDb's poolFactory; `pg` is resolved through packages/db, whose dependency it is):
// - record-write: the next INSERT or UPDATE of app.idempotency_keys that writes status
//   'completed' (as a literal or a parameter) fails without reaching PostgreSQL — the business
//   rows the handler wrote are already in the transaction;
// - commit-ack: the next COMMIT is executed by PostgreSQL, then its acknowledgement is lost (the
//   client sees an error), as when the connection drops during COMMIT.
// Each fault is armed by the handler, inside the transaction, and fires once.
// Connected as couli_app. Top-level it() only (规划/11 §4.3).
import { createRequire } from 'node:module';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, PostgresPool, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  TRACE,
  businessCount,
  businessWrite,
  describeError,
  freshKey,
  idempotencyErrorProblems,
  recordingLogger,
  result,
  rowsOf,
  sensitiveRequest,
  within,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';
const INJECTED_CODE = 'COULI_RULE_TEST_INJECTED';

type Fault = 'record-write' | 'commit-ack' | null;

interface PgClientLike {
  query(text: unknown, params?: unknown): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

const requireFromDb = createRequire(
  new URL('../../../../packages/db/package.json', import.meta.url),
);
const pg = requireFromDb('pg') as { Pool: new (config: unknown) => PgPoolLike };

let database: TestDatabase;
let faulty: Kysely<DB>;
let observer: Kysely<DB>;
let fault: Fault = null;
const fired: string[] = [];
let labelSeq = 0;

function injected(kind: string): Error {
  return Object.assign(new Error(`injected ${kind} failure`), { code: INJECTED_CODE });
}

function isCompletedRecordWrite(text: string, params: unknown): boolean {
  const sql = text.trim().toLowerCase();
  if (!/^(insert|update)\b/.test(sql) || !sql.includes('idempotency_keys')) return false;
  return sql.includes("'completed'") || (Array.isArray(params) && params.includes('completed'));
}

/** A pg client whose `query` applies the armed fault once. */
function faultyClient(client: PgClientLike): PgClientLike {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: unknown, params?: unknown) => {
          if (typeof text === 'string') {
            if (fault === 'record-write' && isCompletedRecordWrite(text, params)) {
              fault = null;
              fired.push('record-write');
              throw injected('record-write');
            }
            if (fault === 'commit-ack' && text.trim().toLowerCase() === 'commit') {
              fault = null;
              await target.query(text, params);
              fired.push('commit-ack');
              throw injected('commit-ack');
            }
          }
          return target.query(text, params);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function faultyPool(config: unknown): PostgresPool {
  const real = new pg.Pool(config);
  // The forced drop at the end ends every session, also one the module may never have given
  // back after a lost COMMIT acknowledgement: such errors are expected and must not surface.
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
        ? (value as (...a: unknown[]) => unknown).bind(target)
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
  // A connection the module never gave back after a lost COMMIT acknowledgement must not hang
  // the run; the database is dropped WITH (FORCE) anyway.
  await within(destroyDb(faulty), 3000);
  await destroyDb(observer);
  await database.drop();
});

function setup() {
  const clock = new FixedClock(T0);
  const { logger, calls } = recordingLogger();
  const idem = () => createIdempotency({ db: faulty, clock, logger });
  return { idem, calls };
}

function freshLabel(): string {
  labelSeq += 1;
  return `idem-fail-${String(labelSeq)}`;
}

/** How a call ended: the resolved value, or the rejection itself. */
async function settle(
  run: () => Promise<unknown>,
): Promise<{ value: unknown } | { error: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

it('[BR-ID-10 细则「作废与业务结果互斥」; BR-WDR-07 ⑧] 业务写入之后 completed 记录写入失败：调用以驱动错误拒绝、不返回响应外壳；业务数据与幂等记录都没有提交；原键重试只产生一次业务效果，再重试是回放', async () => {
  fired.length = 0;
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  let handled = 0;
  const handler = async (trx: Transaction<DB>) => {
    handled += 1;
    await businessWrite(trx, label, handled);
    if (handled === 1) fault = 'record-write';
    return result(0, 200, { attempt: handled });
  };
  const first = await settle(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key }), handler),
  );
  fault = null;
  expect(fired).toEqual(['record-write']);
  expect(
    'error' in first
      ? (first.error as { code?: unknown }).code
      : `resolved ${JSON.stringify(first)}`,
  ).toBe(INJECTED_CODE);
  expect(await businessCount(observer, label)).toBe(0);
  expect(await rowsOf(observer, key)).toEqual([]);
  const okBody = `{"code":0,"msg":"","data":{"attempt":2},"trace_id":"${TRACE}"}`;
  const second = await settle(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key }), handler),
  );
  expect(second).toStrictEqual({ value: { status: 200, body: okBody, source: 'handler' } });
  expect(await businessCount(observer, label)).toBe(1);
  const third = await settle(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key }), handler),
  );
  expect(third).toStrictEqual({ value: { status: 200, body: okBody, source: 'replay' } });
  expect(handled).toBe(2);
  expect(await businessCount(observer, label)).toBe(1);
  expect((await rowsOf(observer, key)).map((row) => row.status)).toEqual(['completed']);
});

it('[BR-ID-10 细则「服务端的配合」] COMMIT 已在数据库生效但确认丢失（提交结果未知）：调用以 IdempotencyError outcome_unknown 拒绝，不返回响应外壳；业务数据与 completed 记录都已提交；原键重试只回放已提交的结果，不再执行', async () => {
  fired.length = 0;
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  let handled = 0;
  const handler = async (trx: Transaction<DB>) => {
    handled += 1;
    await businessWrite(trx, label, handled);
    fault = 'commit-ack';
    return result(0, 201, { withdrawal_id: 'w-commit' });
  };
  const first = await settle(() =>
    idem().executeInTransaction(sensitiveRequest('payout_account_change', { key }), handler),
  );
  fault = null;
  expect(fired).toEqual(['commit-ack']);
  expect(
    'error' in first
      ? idempotencyErrorProblems(
          first.error,
          'outcome_unknown',
          'the transaction outcome is unknown',
        )
      : [`resolved ${JSON.stringify(first.value)}`],
  ).toEqual([]);
  expect('error' in first ? describeError(first.error) : 'resolved').toBe(
    'IdempotencyError outcome_unknown',
  );
  expect(await businessCount(observer, label)).toBe(1);
  const okBody = `{"code":0,"msg":"","data":{"withdrawal_id":"w-commit"},"trace_id":"${TRACE}"}`;
  expect((await rowsOf(observer, key)).map((row) => [row.status, row.response])).toEqual([
    ['completed', { status: 201, body: okBody }],
  ]);
  const again = await settle(() =>
    idem().executeInTransaction(sensitiveRequest('payout_account_change', { key }), handler),
  );
  expect(again).toStrictEqual({ value: { status: 201, body: okBody, source: 'replay' } });
  expect(handled).toBe(1);
  expect(await businessCount(observer, label)).toBe(1);
});

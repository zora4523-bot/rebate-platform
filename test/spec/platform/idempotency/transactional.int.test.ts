// Rule tests for the four sensitive operations (提现申请、收款账号变更、换手机号、申请注销) against a
// real PostgreSQL: the business result and the idempotency record are written in one transaction,
// the unique constraint decides, no processing row is ever committed, a running request makes
// the others of its scope get 40901 without waiting (规划/04 §3.2 idempotency_keys 行, §5「幂等」与
// step-up 行; 08 BR-ID-10 细则「敏感操作的幂等键」「作废与业务结果互斥」, BR-WDR-07 ⑧ 与幂等段,
// BR-ID-08; 规划/02 §18「幂等 API」; contract sections 4–7 of
// apps/api/src/modules/platform/idempotency/index.ts). The handlers' business write is one
// processed_events row (couli_app may insert it), standing in for a withdrawal or an account
// change. Connected as couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createIdempotency,
  type HandlerResult,
  type IdempotentRequest,
  type IdempotentResponse,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  ACTIONS,
  RESPONSES,
  RETENTION_MS,
  SENSITIVE,
  TRACE,
  USER_A,
  USER_B,
  businessCount,
  businessWrite,
  freshKey,
  gate,
  isoPlus,
  outcome,
  recordingLogger,
  result,
  rowsOf,
  sensitiveRequest,
  sha256Hex,
  userActor,
  within,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';

let database: TestDatabase;
let db: Kysely<DB>;
let observer: Kysely<DB>;
let labelSeq = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(db);
  await destroyDb(observer);
  await database.drop();
});

function setup(start: string = T0) {
  const clock = new FixedClock(start);
  const { logger, calls } = recordingLogger();
  const idem = () => createIdempotency({ db, clock, logger });
  return { clock, calls, idem };
}

function runTx(
  idem: () => ReturnType<typeof createIdempotency>,
  req: IdempotentRequest,
  handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
): Promise<IdempotentResponse | { error: string }> {
  return outcome(() => idem().executeInTransaction(req, handler));
}

function freshLabel(): string {
  labelSeq += 1;
  return `idem-rule-${String(labelSeq)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('[BR-ID-10 细则「作废与业务结果互斥」; BR-WDR-07 ⑧; 规划/04 §3.2] 四个操作各自：业务写入与 completed 记录一起提交（主体、方法、路径、哈希、{status, body}、时钟时刻）；提现与收款账号到期 infinity、换手机号与注销 30 天；同键同体重放逐字节相同且不再执行', async () => {
  for (const action of ACTIONS) {
    const { idem } = setup();
    const key = freshKey();
    const label = freshLabel();
    let handled = 0;
    const body = { amount_fen: 10000, note: action };
    const envelope = { code: 0, msg: '', data: { z: 1, id: action }, trace_id: TRACE };
    const okBody = `{"code":0,"msg":"","data":{"z":1,"id":"${action}"},"trace_id":"${TRACE}"}`;
    const handler = async (trx: Transaction<DB>) => {
      handled += 1;
      await businessWrite(trx, label, handled);
      return { status: 201, envelope };
    };
    expect(await runTx(idem, sensitiveRequest(action, { key, body }), handler)).toStrictEqual({
      status: 201,
      body: okBody,
      source: 'handler',
    });
    expect(await businessCount(observer, label)).toBe(1);
    expect(await rowsOf(observer, key)).toEqual([
      {
        subject: `u:${USER_A}`,
        user_id: USER_A,
        method: SENSITIVE[action].method,
        path: SENSITIVE[action].path,
        key,
        request_hash: sha256Hex(`{"amount_fen":10000,"note":"${action}"}`),
        status: 'completed',
        response: { status: 201, body: okBody },
        created: T0,
        expire: SENSITIVE[action].unlimited ? 'infinity' : isoPlus(T0, RETENTION_MS),
      },
    ]);
    expect(
      await runTx(
        idem,
        sensitiveRequest(action, { key, body: { note: action, amount_fen: 10000 } }),
        handler,
      ),
    ).toStrictEqual({ status: 201, body: okBody, source: 'replay' });
    expect(handled).toBe(1);
    expect(await businessCount(observer, label)).toBe(1);
  }
});

it('[BR-ID-10 细则「不为这四个操作提前单独提交 processing 行」] 处理函数执行期间别的会话看不到该键的任何行；同键请求（同体、异体）在 3 秒内得到 40901，不等原事务结束、不执行；原事务提交后同键重放', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  const hold = gate();
  let handled = 0;
  let entered = false;
  const first = runTx(idem, sensitiveRequest('withdraw', { key }), async (trx) => {
    handled += 1;
    await businessWrite(trx, label, 1);
    entered = true;
    await hold.promise;
    return result(0, 200, { w: 1 });
  });
  for (let i = 0; i < 250 && !entered; i += 1) await sleep(20);
  expect(entered).toBe(true);
  expect(await rowsOf(observer, key)).toEqual([]);
  expect(await businessCount(observer, label)).toBe(0);
  for (const body of [{ amount_fen: 10000 }, { amount_fen: 20000 }]) {
    expect(
      await within(
        runTx(idem, sensitiveRequest('withdraw', { key, body }), () => {
          handled += 1;
          return Promise.resolve(result(0, 200));
        }),
        3000,
      ),
    ).toStrictEqual(RESPONSES.e40901);
  }
  expect(await rowsOf(observer, key)).toEqual([]);
  hold.open();
  const okBody = `{"code":0,"msg":"","data":{"w":1},"trace_id":"${TRACE}"}`;
  expect(await first).toStrictEqual({ status: 200, body: okBody, source: 'handler' });
  expect(
    await runTx(idem, sensitiveRequest('withdraw', { key }), () => Promise.resolve(result(0, 200))),
  ).toStrictEqual({ status: 200, body: okBody, source: 'replay' });
  expect(handled).toBe(1);
  expect(await businessCount(observer, label)).toBe(1);
});

it('[BR-ID-10 细则「作废与业务结果互斥」] 处理函数写了业务数据后抛错：同一个错误对象原样抛出，业务写入与幂等记录都回滚；同键再发重新执行并提交', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  const boom = new Error('business failed after writing');
  let caught: unknown;
  try {
    await idem().executeInTransaction(
      sensitiveRequest('payout_account_change', { key }),
      async (trx) => {
        await businessWrite(trx, label, 1);
        throw boom;
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(boom);
  expect(await businessCount(observer, label)).toBe(0);
  expect(await rowsOf(observer, key)).toEqual([]);
  const again = await runTx(
    idem,
    sensitiveRequest('payout_account_change', { key }),
    async (trx) => {
      await businessWrite(trx, label, 2);
      return result(0, 200);
    },
  );
  expect(again).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect(await businessCount(observer, label)).toBe(1);
  expect((await rowsOf(observer, key)).map((row) => row.status)).toEqual(['completed']);
});

it('[BR-WDR-07「1xxxx、2xxxx 不写」; BR-ID-08] 处理函数写了业务数据后返回不写入的码（10003、10405、20001、42901、44001、50001）：响应照常返回，业务写入回滚、没有记录；10003 后沿用原键重放会重新执行', async () => {
  for (const [code, status] of [
    [10003, 403],
    [10405, 403],
    [20001, 400],
    [42901, 429],
    [44001, 403],
    [50001, 500],
  ] as const) {
    const { idem } = setup();
    const key = freshKey();
    const label = freshLabel();
    const refused = result(code, status);
    expect(
      await runTx(idem, sensitiveRequest('phone_change', { key }), async (trx) => {
        await businessWrite(trx, label, 1);
        return refused;
      }),
    ).toStrictEqual({ status, body: JSON.stringify(refused.envelope), source: 'handler' });
    expect(await businessCount(observer, label)).toBe(0);
    expect(await rowsOf(observer, key)).toEqual([]);
    expect(
      await runTx(idem, sensitiveRequest('phone_change', { key }), async (trx) => {
        await businessWrite(trx, label, 2);
        return result(0, 200);
      }),
    ).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","trace_id":"${TRACE}"}`,
      source: 'handler',
    });
    expect(await businessCount(observer, label)).toBe(1);
  }
});

it('[BR-WDR-07「成功和 3xxxx 业务错误写入」; BR-ID-10 细则「键怎样结束」] 3xxxx：与处理函数的写入一起提交为 completed；同键重放原 3xxxx，不再执行', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  let handled = 0;
  const refused = result(30301, 422);
  const refusedBody = `{"code":30301,"msg":"m30301","trace_id":"${TRACE}"}`;
  const handler = async (trx: Transaction<DB>) => {
    handled += 1;
    await businessWrite(trx, label, handled);
    return handled === 1 ? refused : result(0, 200);
  };
  expect(await runTx(idem, sensitiveRequest('withdraw', { key }), handler)).toStrictEqual({
    status: 422,
    body: refusedBody,
    source: 'handler',
  });
  expect(await businessCount(observer, label)).toBe(1);
  expect((await rowsOf(observer, key)).map((row) => [row.status, row.response])).toEqual([
    ['completed', { status: 422, body: refusedBody }],
  ]);
  expect(await runTx(idem, sensitiveRequest('withdraw', { key }), handler)).toStrictEqual({
    status: 422,
    body: refusedBody,
    source: 'replay',
  });
  expect(handled).toBe(1);
});

it('[BR-WDR-07「同 key、不同哈希 → 20901」] 已完成的敏感操作换了请求体 → 20901，不执行、不写业务数据', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  await runTx(idem, sensitiveRequest('account_deletion', { key, body: { reason: 'a' } }), () =>
    Promise.resolve(result(0, 200)),
  );
  let handled = 0;
  expect(
    await runTx(
      idem,
      sensitiveRequest('account_deletion', { key, body: { reason: 'b' } }),
      async (trx) => {
        handled += 1;
        await businessWrite(trx, label, 1);
        return result(0, 200);
      },
    ),
  ).toStrictEqual(RESPONSES.e20901);
  expect(handled).toBe(0);
  expect(await businessCount(observer, label)).toBe(0);
});

it('[BR-ID-10 细则「作废与业务结果互斥」; BR-WDR-07 ⑧] 键已作废（作废原语写入）后，同键请求不论请求体都得到 20903：不执行、不写业务数据，表里只有那条作废记录', async () => {
  const { idem } = setup();
  for (const action of ACTIONS) {
    const key = freshKey();
    const label = freshLabel();
    const abandoned = await outcome(() =>
      idem().abandon({ appId: 'couli', userId: USER_A, action, key, traceId: TRACE }),
    );
    expect(abandoned).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","data":{"outcome":"abandoned","original":null},"trace_id":"${TRACE}"}`,
      source: 'idempotency',
    });
    let handled = 0;
    for (const body of [{ amount_fen: 10000 }, { other: true }, undefined]) {
      expect(
        await runTx(idem, sensitiveRequest(action, { key, body }), async (trx) => {
          handled += 1;
          await businessWrite(trx, label, handled);
          return result(0, 200);
        }),
      ).toStrictEqual(RESPONSES.e20903);
    }
    expect(handled).toBe(0);
    expect(await businessCount(observer, label)).toBe(0);
    expect(
      (await rowsOf(observer, key)).map((row) => [row.status, row.request_hash, row.response]),
    ).toEqual([['abandoned', null, null]]);
  }
});

it('[规划/02 §18「幂等 API」; BR-ID-10 细则「以唯一约束为准」] 并发：同键 8 个敏感请求同时到达，只有 1 个执行并提交，其余 7 个都得到 40901（不抛唯一约束错误、不等原事务）；业务数据只有 1 行；之后同键重放', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  const total = 8;
  let handled = 0;
  let settledCount = 0;
  const handler = async (trx: Transaction<DB>) => {
    handled += 1;
    await businessWrite(trx, label, handled);
    const deadline = Date.now() + 5000;
    while (settledCount < total - 1 && Date.now() < deadline) await sleep(10);
    return result(0, 200, { winner: true });
  };
  const results = await Promise.all(
    Array.from({ length: total }, () =>
      runTx(idem, sensitiveRequest('withdraw', { key }), handler).then((value) => {
        settledCount += 1;
        return value;
      }),
    ),
  );
  const winnerBody = `{"code":0,"msg":"","data":{"winner":true},"trace_id":"${TRACE}"}`;
  expect(handled).toBe(1);
  expect(
    results.filter((r) => JSON.stringify(r) === JSON.stringify(RESPONSES.e40901)),
  ).toHaveLength(7);
  expect(
    results.filter(
      (r) =>
        JSON.stringify(r) === JSON.stringify({ status: 200, body: winnerBody, source: 'handler' }),
    ),
  ).toHaveLength(1);
  expect(await businessCount(observer, label)).toBe(1);
  expect((await rowsOf(observer, key)).map((row) => row.status)).toEqual(['completed']);
  expect(await runTx(idem, sensitiveRequest('withdraw', { key }), handler)).toStrictEqual({
    status: 200,
    body: winnerBody,
    source: 'replay',
  });
});

it('[规划/04 §5「幂等」主体] 敏感操作的同一个键在不同用户下互不影响：用户 B 的请求照常执行，不得到用户 A 的结果；用户 A 作废自己的键不影响用户 B', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  const resA = await runTx(idem, sensitiveRequest('withdraw', { key }), async (trx) => {
    await businessWrite(trx, label, 1);
    return result(0, 200, { who: 'A' });
  });
  const resB = await runTx(
    idem,
    sensitiveRequest('withdraw', { key, actor: userActor(USER_B) }),
    async (trx) => {
      await businessWrite(trx, label, 2);
      return result(0, 200, { who: 'B' });
    },
  );
  expect([resA, resB]).toStrictEqual([
    {
      status: 200,
      body: `{"code":0,"msg":"","data":{"who":"A"},"trace_id":"${TRACE}"}`,
      source: 'handler',
    },
    {
      status: 200,
      body: `{"code":0,"msg":"","data":{"who":"B"},"trace_id":"${TRACE}"}`,
      source: 'handler',
    },
  ]);
  const keyC = freshKey();
  await outcome(() =>
    idem().abandon({
      appId: 'couli',
      userId: USER_A,
      action: 'phone_change',
      key: keyC,
      traceId: TRACE,
    }),
  );
  expect(
    await runTx(
      idem,
      sensitiveRequest('phone_change', { key: keyC, actor: userActor(USER_B) }),
      () => Promise.resolve(result(0, 200, { who: 'B' })),
    ),
  ).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","data":{"who":"B"},"trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect(await businessCount(observer, label)).toBe(2);
  expect((await rowsOf(observer, keyC)).map((row) => [row.subject, row.status])).toEqual([
    [`u:${USER_A}`, 'abandoned'],
    [`u:${USER_B}`, 'completed'],
  ]);
});

it('[规划/04 §5「幂等」] 敏感操作的处理函数返回不合规结果 → IdempotencyError invalid_result，业务写入回滚、没有记录', async () => {
  const { idem } = setup();
  const key = freshKey();
  const label = freshLabel();
  expect(
    await runTx(idem, sensitiveRequest('withdraw', { key }), async (trx) => {
      await businessWrite(trx, label, 1);
      return { status: 200, envelope: { code: 0, msg: '' } } as unknown as HandlerResult;
    }),
  ).toEqual({ error: 'IdempotencyError invalid_result' });
  expect(await businessCount(observer, label)).toBe(0);
  expect(await rowsOf(observer, key)).toEqual([]);
});

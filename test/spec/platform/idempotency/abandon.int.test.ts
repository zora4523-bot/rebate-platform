// Rule tests for the abandon primitive behind POST /v1/idempotency-keys/abandon against a real
// PostgreSQL (规划/04 §6.1 作废接口行, §3.2 idempotency_keys 行, §7 20903 / 40901; 08 BR-ID-10 细则
// 「敏感操作的幂等键」之「作废接口」「作废与业务结果互斥」; contract section 8 of
// apps/api/src/modules/platform/idempotency/index.ts). The route itself is task B1-02.
// Connected as couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createIdempotency,
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
  abandonBody,
  freshKey,
  gate,
  isoPlus,
  outcome,
  recordingLogger,
  request,
  result,
  rowsOf,
  sameResponse,
  sensitiveRequest,
  sha256Hex,
  userActor,
  within,
  type Action,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';

let database: TestDatabase;
let db: Kysely<DB>;
let observer: Kysely<DB>;

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

function abandon(
  idem: () => ReturnType<typeof createIdempotency>,
  action: Action,
  key: string,
  userId: string = USER_A,
  appId = 'couli',
): Promise<IdempotentResponse | { error: string }> {
  return outcome(() => idem().abandon({ appId, userId, action, key, traceId: TRACE }));
}

const ABANDONED = { status: 200, body: abandonBody('abandoned', 'null'), source: 'idempotency' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('[规划/04 §6.1; BR-ID-10 细则「作废接口」] 该键没有记录 → 插入作废记录（status abandoned、无请求体哈希与响应、主体 u:<user>、按 action 定位方法与路径、时钟时刻、提现与收款账号到期 infinity、其余 30 天）并返回 abandoned；再次调用同样返回 abandoned，不多插行', async () => {
  for (const action of ACTIONS) {
    const { idem, calls } = setup();
    const key = freshKey();
    expect(await abandon(idem, action, key)).toStrictEqual(ABANDONED);
    expect(await abandon(idem, action, key)).toStrictEqual(ABANDONED);
    expect(await rowsOf(observer, key)).toEqual([
      {
        subject: `u:${USER_A}`,
        user_id: USER_A,
        method: SENSITIVE[action].method,
        path: SENSITIVE[action].path,
        key,
        request_hash: null,
        status: 'abandoned',
        response: null,
        created: T0,
        expire: SENSITIVE[action].unlimited ? 'infinity' : isoPlus(T0, RETENTION_MS),
      },
    ]);
    expect(calls).toEqual([]);
  }
});

it('[规划/04 §6.1「已有完成的记录时返回 completed 与 original」] 该键已有成功记录 → completed，original 是原响应外壳 {code, msg, data}（原样，不带 trace_id），不插入作废记录、不改原记录；原请求随后重放仍是原结果', async () => {
  const { idem } = setup();
  const key = freshKey();
  const ok = {
    status: 201,
    envelope: { code: 0, msg: '', data: { z: [1], withdrawal_id: 'w-9' }, trace_id: TRACE },
  };
  const okBody = `{"code":0,"msg":"","data":{"z":[1],"withdrawal_id":"w-9"},"trace_id":"${TRACE}"}`;
  await outcome(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key }), () => Promise.resolve(ok)),
  );
  const before = await rowsOf(observer, key);
  expect(await abandon(idem, 'withdraw', key)).toStrictEqual({
    status: 200,
    body: abandonBody('completed', '{"code":0,"msg":"","data":{"z":[1],"withdrawal_id":"w-9"}}'),
    source: 'idempotency',
  });
  expect(await rowsOf(observer, key)).toEqual(before);
  expect(before.map((row) => [row.status, row.request_hash])).toEqual([
    ['completed', sha256Hex('{"amount_fen":10000}')],
  ]);
  expect(
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest('withdraw', { key }), () =>
        Promise.resolve(result(0, 200)),
      ),
    ),
  ).toStrictEqual({ status: 201, body: okBody, source: 'replay' });
});

it('[规划/04 §6.1「原样，含 3xxxx」] 该键已有 3xxxx 记录 → completed，original 带原 code、msg、data；原外壳没有 data 时 original 也没有 data', async () => {
  const { idem } = setup();
  const withData = freshKey();
  await outcome(() =>
    idem().executeInTransaction(sensitiveRequest('payout_account_change', { key: withData }), () =>
      Promise.resolve({
        status: 422,
        envelope: {
          code: 30303,
          msg: 'limit',
          data: { reason: 'payout_account_verify_limit' },
          trace_id: TRACE,
        },
      }),
    ),
  );
  expect(await abandon(idem, 'payout_account_change', withData)).toStrictEqual({
    status: 200,
    body: abandonBody(
      'completed',
      '{"code":30303,"msg":"limit","data":{"reason":"payout_account_verify_limit"}}',
    ),
    source: 'idempotency',
  });
  const noData = freshKey();
  await outcome(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key: noData }), () =>
      Promise.resolve(result(30301, 422)),
    ),
  );
  expect(await abandon(idem, 'withdraw', noData)).toStrictEqual({
    status: 200,
    body: abandonBody('completed', '{"code":30301,"msg":"m30301"}'),
    source: 'idempotency',
  });
});

it('[规划/04 §6.1「原请求仍在处理返回 40901」; BR-ID-10 细则] 原请求的事务还开着时作废 → 3 秒内 40901，不等它结束、不插行；原请求提交后再作废 → completed', async () => {
  const { idem } = setup();
  const key = freshKey();
  const hold = gate();
  let entered = false;
  const original = outcome(() =>
    idem().executeInTransaction(sensitiveRequest('account_deletion', { key }), async () => {
      entered = true;
      await hold.promise;
      return result(0, 200, { deletion: 'scheduled' });
    }),
  );
  for (let i = 0; i < 250 && !entered; i += 1) await sleep(20);
  expect(entered).toBe(true);
  expect(await within(abandon(idem, 'account_deletion', key), 3000)).toStrictEqual(
    RESPONSES.e40901,
  );
  expect(await rowsOf(observer, key)).toEqual([]);
  hold.open();
  expect(await original).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","data":{"deletion":"scheduled"},"trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect(await abandon(idem, 'account_deletion', key)).toStrictEqual({
    status: 200,
    body: abandonBody('completed', '{"code":0,"msg":"","data":{"deletion":"scheduled"}}'),
    source: 'idempotency',
  });
});

it('[规划/04 §6.1; §3.2 processing] 该键有一条已提交的 processing 记录（例如旧数据）→ 作废得到 40901，记录不变', async () => {
  const { idem } = setup();
  const key = freshKey();
  await sql`
    INSERT INTO app.idempotency_keys
      (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at, created_at)
    VALUES ('couli', ${`u:${USER_A}`}, ${USER_A}::uuid, 'POST', '/v1/withdrawals', ${key},
      ${'c'.repeat(64)}, 'processing', NULL, 'infinity', ${T0}::timestamptz)
  `.execute(observer);
  const before = await rowsOf(observer, key);
  expect(await within(abandon(idem, 'withdraw', key), 3000)).toStrictEqual(RESPONSES.e40901);
  expect(await rowsOf(observer, key)).toEqual(before);
});

it('[规划/04 §6.1「之后带该键的请求返回 20903」; BR-ID-01 ④] 作废定位到 action 对应的方法与路径：同一个键在别的路径、别的用户、别的 app 下不受影响，照常执行', async () => {
  const { idem } = setup();
  const key = freshKey();
  expect(await abandon(idem, 'withdraw', key)).toStrictEqual(ABANDONED);
  expect(
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest('withdraw', { key }), () =>
        Promise.resolve(result(0, 200)),
      ),
    ),
  ).toStrictEqual(RESPONSES.e20903);
  const ran: string[] = [];
  const ok = (label: string) => () => {
    ran.push(label);
    return Promise.resolve(result(0, 200, { label }));
  };
  const others = [
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest('payout_account_change', { key }), ok('payout')),
    ),
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest('phone_change', { key }), ok('phone')),
    ),
    await outcome(() =>
      idem().executeInTransaction(
        sensitiveRequest('withdraw', { key, actor: userActor(USER_B) }),
        ok('userB'),
      ),
    ),
    await outcome(() =>
      idem().executeInTransaction(
        sensitiveRequest('withdraw', { key, appId: 'couli2' }),
        ok('app2'),
      ),
    ),
    await outcome(() => idem().execute(request({ key }), ok('standard'))),
  ];
  expect(ran).toEqual(['payout', 'phone', 'userB', 'app2', 'standard']);
  expect(others.map((r) => (r as IdempotentResponse).source)).toEqual([
    'handler',
    'handler',
    'handler',
    'handler',
    'handler',
  ]);
});

it('[规划/04 §6.1; BR-ID-10 细则「主体取自令牌，只能定位本人的键」] 用户 B 作废与用户 A 相同的键：只插入 B 自己的作废记录，A 的已完成记录不变、A 重放照旧；不同 app 同理', async () => {
  const { idem } = setup();
  const key = freshKey();
  const okBody = `{"code":0,"msg":"","data":{"who":"A"},"trace_id":"${TRACE}"}`;
  await outcome(() =>
    idem().executeInTransaction(sensitiveRequest('withdraw', { key }), () =>
      Promise.resolve(result(0, 200, { who: 'A' })),
    ),
  );
  expect(await abandon(idem, 'withdraw', key, USER_B)).toStrictEqual(ABANDONED);
  expect(await abandon(idem, 'withdraw', key, USER_A, 'couli2')).toStrictEqual(ABANDONED);
  const rows = await sql<{ app_id: string; subject: string; status: string }>`
    SELECT app_id, subject, status FROM app.idempotency_keys WHERE key = ${key} ORDER BY id
  `.execute(observer);
  expect(rows.rows).toEqual([
    { app_id: 'couli', subject: `u:${USER_A}`, status: 'completed' },
    { app_id: 'couli', subject: `u:${USER_B}`, status: 'abandoned' },
    { app_id: 'couli2', subject: `u:${USER_A}`, status: 'abandoned' },
  ]);
  expect(
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest('withdraw', { key }), () =>
        Promise.resolve(result(0, 200)),
      ),
    ),
  ).toStrictEqual({ status: 200, body: okBody, source: 'replay' });
});

it('[BR-ID-10 细则「作废与业务结果互斥」] 并发：同一个键的作废与原请求同时到达，结果只有两种——要么作废成功、原请求 20903 或 40901 且不执行；要么原请求执行、作废得到 40901 或 completed；表里只有一行且与回答一致', async () => {
  for (let round = 0; round < 10; round += 1) {
    const { idem } = setup();
    const key = freshKey();
    let handled = 0;
    const [res, ab] = await Promise.all([
      outcome(() =>
        idem().executeInTransaction(sensitiveRequest('withdraw', { key }), async () => {
          handled += 1;
          await sleep(round % 3 === 0 ? 0 : 30);
          return result(0, 200, { round });
        }),
      ),
      abandon(idem, 'withdraw', key),
    ]);
    const rows = (await rowsOf(observer, key)).map((row) => row.status);
    const okBody = `{"code":0,"msg":"","data":{"round":${String(round)}},"trace_id":"${TRACE}"}`;
    if (sameResponse(ab, ABANDONED)) {
      expect(sameResponse(res, RESPONSES.e20903) || sameResponse(res, RESPONSES.e40901)).toBe(true);
      expect(handled).toBe(0);
      expect(rows).toEqual(['abandoned']);
    } else {
      expect(res).toStrictEqual({ status: 200, body: okBody, source: 'handler' });
      expect(handled).toBe(1);
      expect(rows).toEqual(['completed']);
      const completed = {
        status: 200,
        body: abandonBody('completed', `{"code":0,"msg":"","data":{"round":${String(round)}}}`),
        source: 'idempotency',
      };
      expect(sameResponse(ab, RESPONSES.e40901) || sameResponse(ab, completed)).toBe(true);
    }
  }
});

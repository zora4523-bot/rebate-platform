// Rule tests for the standard mode of Idempotency-Key handling against a real PostgreSQL (规划/04
// §5「幂等」, §3.2 idempotency_keys; 08 BR-WDR-07 幂等段, BR-ID-01 ④, BR-ID-08, BR-ID-10 细则「恢复
// 执行时用哪个幂等键」; 规划/02 §18「幂等 API」; contract sections 1–5, 7, 10 of
// apps/api/src/modules/platform/idempotency/index.ts). Each file gets its own clone of the
// migrated template and connects as the business role couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createIdempotency,
  type HandlerResult,
  type IdempotentRequest,
  type IdempotentResponse,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  APP,
  DEVICE_A,
  RESPONSES,
  RETENTION_MS,
  TRACE,
  USER_A,
  USER_B,
  deviceActor,
  freshKey,
  gate,
  hmacOf,
  isoPlus,
  outcome,
  phoneActor,
  recordingLogger,
  request,
  result,
  rowsOf,
  sameResponse,
  sha256Hex,
  userActor,
  within,
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

function setup(start: string = T0, processingLeaseMs?: number) {
  const clock = new FixedClock(start);
  const { logger, calls } = recordingLogger();
  const idem = () =>
    createIdempotency(
      processingLeaseMs === undefined
        ? { db, clock, logger }
        : { db, clock, logger, processingLeaseMs },
    );
  return { clock, calls, idem };
}

function run(
  idem: () => ReturnType<typeof createIdempotency>,
  req: IdempotentRequest,
  handler: () => Promise<HandlerResult>,
): Promise<IdempotentResponse | { error: string }> {
  return outcome(() => idem().execute(req, handler));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('[规划/04 §5「幂等」; BR-WDR-07] 首次执行写入 completed 记录（主体、user_id、方法、路径、键、请求体哈希、{status, body}、时钟时刻与 30 天到期）；同键同体重放原样返回状态码与响应体（逐字节，含原 trace_id、原键顺序），不再调用处理函数，全程不写日志', async () => {
  const { idem, calls } = setup();
  const key = freshKey();
  const path = '/v1/links/0199a3b4-5c6d-7e8f-9a0b-00000000a001/open';
  const body = { no_rebate: false, installed: 'unknown', extra: { b: [2, 1], a: null } };
  const canonical = '{"extra":{"a":null,"b":[2,1]},"installed":"unknown","no_rebate":false}';
  const first: HandlerResult = {
    status: 201,
    envelope: {
      code: 0,
      msg: '',
      data: { zz: 1, link_id: 'L1', url: 'https://s.example/a?b=1&c=é', aa: [true] },
      trace_id: TRACE,
    },
  };
  const firstBody = `{"code":0,"msg":"","data":{"zz":1,"link_id":"L1","url":"https://s.example/a?b=1&c=é","aa":[true]},"trace_id":"${TRACE}"}`;
  let handled = 0;
  const got = await run(idem, request({ key, path, body }), () => {
    handled += 1;
    return Promise.resolve(first);
  });
  expect(got).toStrictEqual({ status: 201, body: firstBody, source: 'handler' });
  expect(await rowsOf(observer, key)).toEqual([
    {
      subject: `u:${USER_A}`,
      user_id: USER_A,
      method: 'POST',
      path,
      key,
      request_hash: sha256Hex(canonical),
      status: 'completed',
      response: { status: 201, body: firstBody },
      created: T0,
      expire: isoPlus(T0, RETENTION_MS),
    },
  ]);
  const reordered = { extra: { a: null, b: [2, 1] }, installed: 'unknown', no_rebate: false };
  const replay = await run(
    idem,
    request({ key, path, body: reordered, traceId: '0199a3b4-0000-7000-8000-000000000001' }),
    () => {
      handled += 1;
      return Promise.resolve(result(0, 200, { other: true }));
    },
  );
  expect(replay).toStrictEqual({ status: 201, body: firstBody, source: 'replay' });
  expect(handled).toBe(1);
  expect(calls).toEqual([]);
});

it('[BR-WDR-07; BR-ID-10 细则「恢复执行时用哪个幂等键」] 3xxxx 业务错误写入幂等结果：同键重放返回原 3xxxx（原 HTTP 状态 422），即使处理函数现在会成功也不再调用', async () => {
  const { idem } = setup();
  const key = freshKey();
  let handled = 0;
  const stored = result(30101, 422, { auth_url: 'https://auth.example/x', state: 's1' });
  const storedBody = `{"code":30101,"msg":"m30101","data":{"auth_url":"https://auth.example/x","state":"s1"},"trace_id":"${TRACE}"}`;
  expect(
    await run(idem, request({ key }), () => {
      handled += 1;
      return Promise.resolve(stored);
    }),
  ).toStrictEqual({ status: 422, body: storedBody, source: 'handler' });
  expect(
    await run(idem, request({ key }), () => {
      handled += 1;
      return Promise.resolve(result(0, 200));
    }),
  ).toStrictEqual({ status: 422, body: storedBody, source: 'replay' });
  expect(handled).toBe(1);
  const rows = await rowsOf(observer, key);
  expect(rows.map((row) => [row.status, row.response])).toEqual([
    ['completed', { status: 422, body: storedBody }],
  ]);
});

it('[BR-WDR-07「成功和 3xxxx 写入、1xxxx 2xxxx 不写」; 规划/04 §5] 码 0 与 30000～39999 写入；1xxxx、2xxxx、4xxxx、5xxxx 不写：响应照常返回，记录被删掉，同键可以再发并重新执行', async () => {
  const notStored: [number, number][] = [
    [10001, 401],
    [10003, 403],
    [10405, 403],
    [20001, 400],
    [20004, 400],
    [29999, 400],
    [40000, 409],
    [42901, 429],
    [44001, 403],
    [50001, 500],
    [50401, 504],
  ];
  for (const [code, status] of notStored) {
    const { idem } = setup();
    const key = freshKey();
    let handled = 0;
    const first = result(code, status);
    expect(
      await run(idem, request({ key }), () => {
        handled += 1;
        return Promise.resolve(first);
      }),
    ).toStrictEqual({ status, body: JSON.stringify(first.envelope), source: 'handler' });
    expect(await rowsOf(observer, key)).toEqual([]);
    const second = await run(idem, request({ key }), () => {
      handled += 1;
      return Promise.resolve(result(0, 200, { n: code }));
    });
    expect(second).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","data":{"n":${String(code)}},"trace_id":"${TRACE}"}`,
      source: 'handler',
    });
    expect(handled).toBe(2);
  }
  for (const [code, status] of [
    [0, 200],
    [30000, 422],
    [30303, 422],
    [39999, 422],
  ] as const) {
    const { idem } = setup();
    const key = freshKey();
    const first = result(code, status, { c: code });
    await run(idem, request({ key }), () => Promise.resolve(first));
    const rows = await rowsOf(observer, key);
    expect(rows.map((row) => [row.status, row.response])).toEqual([
      ['completed', { status, body: JSON.stringify(first.envelope) }],
    ]);
  }
});

it('[BR-ID-08] 1xxxx（如 10003 需要二次验证）不写记录：沿用原键重放时重新执行；成功后同键再发得到成功结果的重放', async () => {
  const { idem } = setup();
  const key = freshKey();
  const outcomes = [result(10003, 403), result(0, 200, { withdrawal: 'w' })];
  let handled = 0;
  const handler = () => {
    const next = outcomes[Math.min(handled, outcomes.length - 1)];
    handled += 1;
    return Promise.resolve(next as HandlerResult);
  };
  expect(await run(idem, request({ key }), handler)).toStrictEqual({
    status: 403,
    body: `{"code":10003,"msg":"m10003","trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  const okBody = `{"code":0,"msg":"","data":{"withdrawal":"w"},"trace_id":"${TRACE}"}`;
  expect(await run(idem, request({ key }), handler)).toStrictEqual({
    status: 200,
    body: okBody,
    source: 'handler',
  });
  expect(await run(idem, request({ key }), handler)).toStrictEqual({
    status: 200,
    body: okBody,
    source: 'replay',
  });
  expect(handled).toBe(2);
});

it('[BR-WDR-07; 规划/04 §5] 处理函数抛错：同一个错误对象原样抛出，不写记录（处理中的行被删掉），同键可以再发并执行', async () => {
  const { idem, calls } = setup();
  const key = freshKey();
  const boom = new Error('handler failed');
  let caught: unknown;
  try {
    await idem().execute(request({ key }), () => Promise.reject(boom));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(boom);
  expect(await rowsOf(observer, key)).toEqual([]);
  let handled = 0;
  expect(
    await run(idem, request({ key }), () => {
      handled += 1;
      return Promise.resolve(result(0, 200));
    }),
  ).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect(handled).toBe(1);
  // A synchronous throw inside the handler counts the same.
  const key2 = freshKey();
  const sync = new TypeError('sync failure');
  let caught2: unknown;
  try {
    await idem().execute(request({ key: key2 }), () => {
      throw sync;
    });
  } catch (error) {
    caught2 = error;
  }
  expect(caught2).toBe(sync);
  expect(await rowsOf(observer, key2)).toEqual([]);
  expect(calls).toEqual([]);
});

it('[规划/04 §5「幂等」] 处理函数返回不合规的结果 → IdempotencyError invalid_result，不写记录，同键可以再发', async () => {
  const bad: unknown[] = [
    { status: 99, envelope: { code: 0, msg: '', trace_id: TRACE } },
    { status: 600, envelope: { code: 0, msg: '', trace_id: TRACE } },
    { status: 200.5, envelope: { code: 0, msg: '', trace_id: TRACE } },
    { status: 200, envelope: { code: '0', msg: '', trace_id: TRACE } },
    { status: 200, envelope: { code: -1, msg: '', trace_id: TRACE } },
    { status: 200, envelope: { code: 0, trace_id: TRACE } },
    { status: 200, envelope: { code: 0, msg: '' } },
    { status: 200 },
    null,
  ];
  for (const value of bad) {
    const { idem } = setup();
    const key = freshKey();
    expect(
      await run(idem, request({ key }), () => Promise.resolve(value as HandlerResult)),
    ).toEqual({ error: 'IdempotencyError invalid_result' });
    expect(await rowsOf(observer, key)).toEqual([]);
    expect(await run(idem, request({ key }), () => Promise.resolve(result(0, 200)))).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","trace_id":"${TRACE}"}`,
      source: 'handler',
    });
  }
});

it('[BR-WDR-07「同 key、不同哈希 → 20901」] 已完成的键换了请求体 → 20901（HTTP 409，信封确切），不调用处理函数，记录不变', async () => {
  const { idem } = setup();
  const key = freshKey();
  await run(idem, request({ key, body: { a: 1 } }), () => Promise.resolve(result(0, 200)));
  const before = await rowsOf(observer, key);
  let handled = 0;
  for (const body of [{ a: 2 }, { a: 1, b: null }, undefined, null, [{ a: 1 }]]) {
    expect(
      await run(idem, request({ key, body }), () => {
        handled += 1;
        return Promise.resolve(result(0, 200));
      }),
    ).toStrictEqual(RESPONSES.e20901);
  }
  expect(handled).toBe(0);
  expect(await rowsOf(observer, key)).toEqual(before);
});

it('[BR-WDR-07「同 key 的首个请求还没完成 → 40901」; 规划/04 §5] 普通模式处理中：已提交一条 processing 行（有请求体哈希、无响应）；同键请求（同体或异体）→ 40901，不调用处理函数；完成后同键重放', async () => {
  const { idem } = setup();
  const key = freshKey();
  const hold = gate();
  let handled = 0;
  const firstBody = { amount: 1 };
  const first = run(idem, request({ key, body: firstBody }), async () => {
    handled += 1;
    await hold.promise;
    return result(0, 200, { done: 1 });
  });
  let rows: Awaited<ReturnType<typeof rowsOf>> = [];
  for (let i = 0; i < 100 && rows.length === 0; i += 1) {
    rows = await rowsOf(observer, key);
    if (rows.length === 0) await sleep(20);
  }
  expect(rows).toEqual([
    {
      subject: `u:${USER_A}`,
      user_id: USER_A,
      method: 'POST',
      path: request().path,
      key,
      request_hash: sha256Hex('{"amount":1}'),
      status: 'processing',
      response: null,
      created: T0,
      expire: isoPlus(T0, RETENTION_MS),
    },
  ]);
  for (const body of [firstBody, { amount: 2 }]) {
    expect(
      await within(
        run(idem, request({ key, body }), () => {
          handled += 1;
          return Promise.resolve(result(0, 200));
        }),
        3000,
      ),
    ).toStrictEqual(RESPONSES.e40901);
  }
  hold.open();
  const doneBody = `{"code":0,"msg":"","data":{"done":1},"trace_id":"${TRACE}"}`;
  expect(await first).toStrictEqual({ status: 200, body: doneBody, source: 'handler' });
  expect(
    await run(idem, request({ key, body: firstBody }), () => Promise.resolve(result(0, 201))),
  ).toStrictEqual({ status: 200, body: doneBody, source: 'replay' });
  expect(handled).toBe(1);
});

it('[规划/02 §18「幂等 API」; 规划/04 §3.2 唯一约束] 并发：同主体同键同体 8 个请求同时到达，只有 1 个执行处理函数，其余 7 个都得到 40901（不抛唯一约束错误）；表里只有 1 行；之后同键重放', async () => {
  const { idem } = setup();
  const key = freshKey();
  const total = 8;
  let handled = 0;
  let settledCount = 0;
  const handler = async () => {
    handled += 1;
    const deadline = Date.now() + 5000;
    while (settledCount < total - 1 && Date.now() < deadline) await sleep(10);
    return result(0, 200, { winner: true });
  };
  const runs = Array.from({ length: total }, () =>
    run(idem, request({ key, body: { same: 1 } }), handler).then((value) => {
      settledCount += 1;
      return value;
    }),
  );
  const results = await Promise.all(runs);
  const winnerBody = `{"code":0,"msg":"","data":{"winner":true},"trace_id":"${TRACE}"}`;
  expect(handled).toBe(1);
  expect(results.filter((r) => sameResponse(r, RESPONSES.e40901))).toHaveLength(7);
  expect(
    results.filter((r) => sameResponse(r, { status: 200, body: winnerBody, source: 'handler' })),
  ).toHaveLength(1);
  expect((await rowsOf(observer, key)).map((row) => row.status)).toEqual(['completed']);
  expect(await run(idem, request({ key, body: { same: 1 } }), handler)).toStrictEqual({
    status: 200,
    body: winnerBody,
    source: 'replay',
  });
  expect(handled).toBe(1);
});

it('[规划/04 §5「幂等」唯一 (app_id, subject, method, path, key)] 同一个键在不同主体（用户 A、用户 B、设备、落地页手机号）、不同 app、不同方法、不同路径下互不影响：各自执行、各自一行、各自重放自己的结果', async () => {
  const { idem } = setup();
  const key = freshKey();
  const phone = hmacOf('phone-a');
  const scopes: [string, Partial<IdempotentRequest>, string, string | null][] = [
    ['userA', { actor: userActor(USER_A) }, `u:${USER_A}`, USER_A],
    ['userB', { actor: userActor(USER_B) }, `u:${USER_B}`, USER_B],
    ['device', { actor: deviceActor(DEVICE_A) }, `d:${DEVICE_A}`, null],
    ['phone', { actor: phoneActor('phone-a') }, `p:${phone}`, null],
    ['otherApp', { appId: 'couli2' }, `u:${USER_A}`, USER_A],
    ['put', { method: 'PUT' }, `u:${USER_A}`, USER_A],
    [
      'otherPath',
      { path: '/v1/links/0199a3b4-5c6d-7e8f-9a0b-00000000bbbb/open' },
      `u:${USER_A}`,
      USER_A,
    ],
  ];
  let handled = 0;
  for (const [label, overrides] of scopes) {
    const got = await run(idem, request({ key, ...overrides }), () => {
      handled += 1;
      return Promise.resolve(result(0, 200, { scope: label }));
    });
    expect(got).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","data":{"scope":"${label}"},"trace_id":"${TRACE}"}`,
      source: 'handler',
    });
  }
  expect(handled).toBe(scopes.length);
  const rows = await sql<{
    app_id: string;
    subject: string;
    user_id: string | null;
    method: string;
    path: string;
  }>`
    SELECT app_id, subject, user_id::text AS user_id, method, path FROM app.idempotency_keys
    WHERE key = ${key} ORDER BY id
  `.execute(observer);
  expect(rows.rows).toEqual(
    scopes.map(([, overrides, subject, userId]) => ({
      app_id: overrides.appId ?? APP,
      subject,
      user_id: userId,
      method: overrides.method ?? 'POST',
      path: overrides.path ?? request().path,
    })),
  );
  for (const [label, overrides] of scopes) {
    expect(
      await run(idem, request({ key, ...overrides }), () => Promise.resolve(result(0, 200))),
    ).toStrictEqual({
      status: 200,
      body: `{"code":0,"msg":"","data":{"scope":"${label}"},"trace_id":"${TRACE}"}`,
      source: 'replay',
    });
  }
  expect(DEVICE_A).not.toBe(USER_A);
});

it('[规划/04 §5「幂等」处理中租约（待编排会话确认）] 缺省租约 60000 毫秒：processing 行建于 59999 毫秒前 → 40901；满 60000 毫秒 → 被接管并执行（行的哈希、created_at、expire_at 换成接管请求的）', async () => {
  const { idem, clock } = setup();
  const key = freshKey();
  const hold = gate();
  const stale = run(idem, request({ key, body: { v: 1 } }), async () => {
    await hold.promise;
    return result(0, 200, { by: 'stale' });
  });
  for (let i = 0; i < 100 && (await rowsOf(observer, key)).length === 0; i += 1) await sleep(20);
  clock.set(isoPlus(T0, 59_999));
  expect(
    await run(idem, request({ key, body: { v: 1 } }), () => Promise.resolve(result(0, 200))),
  ).toStrictEqual(RESPONSES.e40901);
  clock.set(isoPlus(T0, 60_000));
  const takeover = await run(idem, request({ key, body: { v: 2 } }), () =>
    Promise.resolve(result(0, 200, { by: 'takeover' })),
  );
  const takeoverBody = `{"code":0,"msg":"","data":{"by":"takeover"},"trace_id":"${TRACE}"}`;
  expect(takeover).toStrictEqual({ status: 200, body: takeoverBody, source: 'handler' });
  expect(await rowsOf(observer, key)).toEqual([
    expect.objectContaining({
      request_hash: sha256Hex('{"v":2}'),
      status: 'completed',
      response: { status: 200, body: takeoverBody },
      created: isoPlus(T0, 60_000),
      expire: isoPlus(T0, 60_000 + RETENTION_MS),
    }),
  ]);
  hold.open();
  await stale;
});

it('[规划/04 §5「幂等」处理中租约（待编排会话确认）] 被接管的原请求完成时不覆盖、不删除接管者的记录，只记一行 warn idempotency_record_lost {method, path}（不含请求体、键、哈希、响应），并照常返回自己的响应', async () => {
  const lease = 1000;
  const { idem, clock, calls } = setup(T0, lease);
  const marker = 'body-marker-7f3a';
  const path = '/v1/links/0199a3b4-5c6d-7e8f-9a0b-00000000c0c0/open';
  // Original finishes with a stored result after the takeover completed.
  const keyA = freshKey();
  const holdA = gate();
  const original = run(idem, request({ key: keyA, path, body: { m: marker } }), async () => {
    await holdA.promise;
    return result(0, 200, { by: 'original', m: marker });
  });
  for (let i = 0; i < 100 && (await rowsOf(observer, keyA)).length === 0; i += 1) await sleep(20);
  clock.set(isoPlus(T0, lease - 1));
  expect(
    await run(idem, request({ key: keyA, path, body: { m: marker } }), () =>
      Promise.resolve(result(0, 200)),
    ),
  ).toStrictEqual(RESPONSES.e40901);
  clock.set(isoPlus(T0, lease));
  const takeoverBody = `{"code":0,"msg":"","data":{"by":"takeover"},"trace_id":"${TRACE}"}`;
  expect(
    await run(idem, request({ key: keyA, path, body: { m: marker } }), () =>
      Promise.resolve(result(0, 200, { by: 'takeover' })),
    ),
  ).toStrictEqual({ status: 200, body: takeoverBody, source: 'handler' });
  holdA.open();
  expect(await original).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","data":{"by":"original","m":"${marker}"},"trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect((await rowsOf(observer, keyA)).map((row) => row.response)).toEqual([
    { status: 200, body: takeoverBody },
  ]);
  expect(calls).toEqual([
    { method: 'warn', args: [{ method: 'POST', path }, 'idempotency_record_lost'] },
  ]);
  // Original finishes with a result that is not stored while the takeover is still running:
  // the takeover's processing row stays and then completes.
  clock.set(T0);
  const keyB = freshKey();
  const holdB1 = gate();
  const holdB2 = gate();
  const originalB = run(idem, request({ key: keyB, path, body: { m: marker } }), async () => {
    await holdB1.promise;
    return result(10003, 403);
  });
  for (let i = 0; i < 100 && (await rowsOf(observer, keyB)).length === 0; i += 1) await sleep(20);
  clock.set(isoPlus(T0, lease));
  const takeoverB = run(idem, request({ key: keyB, path, body: { m: marker } }), async () => {
    await holdB2.promise;
    return result(0, 200, { by: 'takeoverB' });
  });
  for (let i = 0; i < 100; i += 1) {
    const rows = await rowsOf(observer, keyB);
    if (rows[0]?.created === isoPlus(T0, lease)) break;
    await sleep(20);
  }
  holdB1.open();
  expect(await originalB).toStrictEqual({
    status: 403,
    body: `{"code":10003,"msg":"m10003","trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect((await rowsOf(observer, keyB)).map((row) => [row.status, row.created])).toEqual([
    ['processing', isoPlus(T0, lease)],
  ]);
  holdB2.open();
  await takeoverB;
  expect((await rowsOf(observer, keyB)).map((row) => row.status)).toEqual(['completed']);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({
    method: 'warn',
    args: [{ method: 'POST', path }, 'idempotency_record_lost'],
  });
  expect(JSON.stringify(calls)).not.toContain(marker);
  expect(JSON.stringify(calls)).not.toContain(keyA);
  expect(JSON.stringify(calls)).not.toContain(keyB);
});

it('[ADR-0001 §4.2 第 10 项 时钟; BR-ID-30 ⑤] 记录的 created_at 与 expire_at 只取注入的 Clock（不取数据库 now()）；完成时保持认领时的值，处理函数里时钟前进也不变', async () => {
  const start = '2029-02-03T04:05:06.789Z';
  const { idem, clock } = setup(start);
  const key = freshKey();
  await run(idem, request({ key }), () => {
    clock.advanceMs(5000);
    return Promise.resolve(result(0, 200));
  });
  const rows = await rowsOf(observer, key);
  expect(rows.map((row) => [row.created, row.expire])).toEqual([
    [start, isoPlus(start, RETENTION_MS)],
  ]);
});

// B1-02g §9.1–9.3 / BR-ID-10 abandon HTTP boundary. The original operation is never
// executed through a production adapter. Version/scope/ban decisions belong to later guards.
// AC-B1-02g labels are task-local acceptance identifiers, not new planning ACs.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { IdempotencyError } from '../../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  ACTIONS,
  PATH,
  accepted,
  client,
  openHttp,
  originalRequest,
  rejected,
  rows,
  entryApp,
  type Fixture,
} from './http-kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 30_000);
const abandoned = { outcome: 'abandoned', original: null };

it.each(ACTIONS)('[AC-B1-02g#2] $action 无记录作废、重复不增行、迟到原操作 20903', async (op) => {
  const c = await client(f);
  const key = randomUUID();
  const body = { action: op.action, idempotency_key: key };
  const trace = randomUUID();
  // Neither Idempotency-Key nor step_up_token is supplied.
  accepted(f, await c.send(body, { trace }), abandoned, trace);
  const before = await rows(f, key);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    app_id: c.appId,
    subject: `u:${c.uid}`,
    user_id: c.uid,
    method: op.method,
    path: op.path,
    key,
    status: 'abandoned',
    request_hash: null,
    response: null,
  });
  accepted(f, await c.send(body), abandoned);
  expect(await rows(f, key)).toEqual(before);
  const handler = vi.fn(async () => ({
    status: 200,
    envelope: { code: 0, msg: '', trace_id: trace },
  }));
  const late = await f.idem.executeInTransaction(originalRequest(c, op, key), handler);
  expect(late.status).toBe(409);
  expect(JSON.parse(late.body)).toMatchObject({ code: 20903 });
  expect(handler).not.toHaveBeenCalled();
  expect(await rows(f, key)).toEqual(before);
  expect(f.lines.join('')).not.toContain(key);
});

it('[AC-B1-02g#3] 同一用户同一个 key 按四种原操作分别定位', async () => {
  const c = await client(f);
  const key = randomUUID();
  for (const op of ACTIONS) {
    accepted(f, await c.send({ action: op.action, idempotency_key: key }), abandoned);
  }
  const records = await rows(f, key);
  expect(records).toHaveLength(4);
  expect(records.map(({ method, path }) => ({ method, path }))).toEqual(
    ACTIONS.map(({ method, path }) => ({ method, path })),
  );
});

it.each([
  { code: 0, msg: '原成功结果', data: { receipt: 'saved', nested: [null, { ok: true }] } },
  { code: 30303, msg: '原业务失败', data: { reason: 'payout_account_verify_limit' } },
  { code: 30301, msg: '无 data 的原业务失败' },
])('[AC-B1-02g#4] 已完成 $code 返回原 code/msg/data，不改记录或重放结果', async (original) => {
  const c = await client(f);
  const key = randomUUID();
  const op = ACTIONS[1];
  const request = originalRequest(c, op, key);
  const stored = await f.idem.executeInTransaction(request, async () => ({
    status: original.code === 0 ? 201 : 422,
    envelope: { ...original, trace_id: randomUUID() },
  }));
  expect(stored.source).toBe('handler');
  const before = await rows(f, key);
  expect(before[0]?.status).toBe('completed');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    accepted(f, await c.send({ action: op.action, idempotency_key: key }), {
      outcome: 'completed',
      original,
    });
    expect(await rows(f, key)).toEqual(before);
  }
  const handler = vi.fn(async () => ({
    status: 200,
    envelope: { code: 0, msg: '', trace_id: randomUUID() },
  }));
  const replay = await f.idem.executeInTransaction(request, handler);
  expect(replay).toEqual({ ...stored, source: 'replay' });
  expect(handler).not.toHaveBeenCalled();
});

it('[AC-B1-02g#5] processing 原样返回 HTTP 409 / 40901，不把待确认键改成作废', async () => {
  const c = await client(f);
  const key = randomUUID();
  await sql`INSERT INTO app.idempotency_keys
    (app_id,subject,user_id,method,path,key,request_hash,status,response,created_at,expire_at)
    VALUES (${c.appId},${`u:${c.uid}`},${c.uid}::uuid,'POST','/v1/withdrawals',${key},
      ${'a'.repeat(64)},'processing',NULL,${f.clock.now()},'infinity')`.execute(f.db);
  const before = await rows(f, key);
  rejected(f, await c.send({ action: 'withdraw', idempotency_key: key }), 409, 40901);
  expect(await rows(f, key)).toEqual(before);
});

it('[AC-B1-02g#6] 原事务未提交时 HTTP 作废及时返回 40901，提交后返回 completed', async () => {
  const c = await client(f);
  const key = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = { code: 0, msg: '已完成', data: { deletion: 'scheduled' } };
  const pending = f.idem.executeInTransaction(originalRequest(c, ACTIONS[3], key), async () => {
    entered.resolve();
    await release.promise;
    return { status: 200, envelope: { ...original, trace_id: randomUUID() } };
  });
  // Race the signal with completion: a setup failure propagates instead of hanging the test.
  await Promise.race([entered.promise, pending]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      c.send({ action: 'account_deletion', idempotency_key: key }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]);
    expect(response, '未提交原事务不应阻塞作废请求').not.toBeNull();
    rejected(f, response!, 409, 40901);
    expect(await rows(f, key)).toEqual([]);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await pending;
  }
  accepted(f, await c.send({ action: 'account_deletion', idempotency_key: key }), {
    outcome: 'completed',
    original,
  });
});

it('[AC-B1-02g#7] 他人同键完成记录不可见；只插入令牌本人的作废记录', async () => {
  const owner = await client(f);
  const caller = await client(f);
  const key = randomUUID();
  await f.idem.executeInTransaction(originalRequest(owner, ACTIONS[0], key), async () => ({
    status: 200,
    envelope: { code: 0, msg: '', data: { private: 'owner-only' }, trace_id: randomUUID() },
  }));
  const before = await rows(f, key);
  accepted(f, await caller.send({ action: 'withdraw', idempotency_key: key }), abandoned);
  const after = await rows(f, key);
  expect(after).toHaveLength(2);
  expect(after.find((row) => row.subject === `u:${owner.uid}`)).toEqual(before[0]);
  expect(after.find((row) => row.subject === `u:${caller.uid}`)).toMatchObject({
    app_id: caller.appId,
    user_id: caller.uid,
    status: 'abandoned',
    request_hash: null,
    response: null,
  });
});

it('[AC-B1-02g#8] 非默认 app 的令牌定位该 app；跨 app 令牌 10403 且不调用作废原语', async () => {
  const c = await client(f, 'couli_alt');
  const other = await client(f);
  const key = randomUUID();
  const body = { action: 'withdraw', idempotency_key: key };
  // Stage ③ uses the token app after login. A verified device is a signing identity,
  // not the owner of the key: distinguish principal.app_id from verifiedDevice.appId.
  accepted(
    f,
    await other.send(body, { token: c.token, headers: { 'x-app-id': c.appId } }),
    abandoned,
  );
  accepted(f, await c.send(body), abandoned);
  expect(await rows(f, key)).toEqual([
    expect.objectContaining({ app_id: 'couli_alt', subject: `u:${c.uid}` }),
  ]);
  const blockedKey = randomUUID();
  const spy = vi.spyOn(f.idem, 'abandon');
  try {
    rejected(
      f,
      await c.send({ ...body, idempotency_key: blockedKey }, { token: other.token }),
      403,
      10403,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(await rows(f, blockedKey)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it.each([
  {
    label: '非四值 action',
    body: { action: 'login', idempotency_key: 'valid_key' },
    field: 'action',
  },
  { label: '缺 action', body: { idempotency_key: 'valid_key' }, field: 'action' },
  { label: '缺 key', body: { action: 'withdraw' }, field: 'idempotency_key' },
  {
    label: '短 key',
    body: { action: 'withdraw', idempotency_key: 'short' },
    field: 'idempotency_key',
  },
  {
    label: '超长 key',
    body: { action: 'withdraw', idempotency_key: 'a'.repeat(65) },
    field: 'idempotency_key',
  },
  {
    label: '非法 key 字符',
    body: { action: 'withdraw', idempotency_key: 'bad key!' },
    field: 'idempotency_key',
  },
  {
    label: '数值 key',
    body: { action: 'withdraw', idempotency_key: 12345678 },
    field: 'idempotency_key',
  },
  {
    label: '注入主体',
    body: { action: 'withdraw', idempotency_key: 'valid_key', user_id: 'forged' },
    field: 'user_id',
  },
])(
  '[AC-B1-02g#9] $label 返回 400 / 20001，data.fields 指明字段且无写库',
  async ({ body, field }) => {
    const c = await client(f);
    const before = await f.db
      .withSchema('app')
      .selectFrom('idempotency_keys')
      .selectAll()
      .orderBy('id')
      .execute();
    const response = await c.send(body);
    rejected(f, response, 400, 20001);
    expect(response.json<{ data: { fields: string[] } }>().data.fields).toContain(field);
    expect(
      await f.db
        .withSchema('app')
        .selectFrom('idempotency_keys')
        .selectAll()
        .orderBy('id')
        .execute(),
    ).toEqual(before);
  },
);

it.each([8, 64])('[AC-B1-02g#10] 接受 %i 字符合法 key 的边界值', async (length) => {
  const c = await client(f);
  const key = `A_-${randomBytes(32).toString('hex')}`.slice(0, length);
  accepted(f, await c.send({ action: 'withdraw', idempotency_key: key }), abandoned);
  expect(await rows(f, key)).toHaveLength(1);
});

it.each([
  { label: '缺令牌', token: null, code: 10001 },
  { label: '坏令牌', token: 'invalid-access-token', code: 10002 },
])('[AC-B1-02g#11] $label 由守卫拒绝，无作废副作用；有效令牌可恢复', async ({ token, code }) => {
  const c = await client(f);
  const key = randomUUID();
  const body = { action: 'withdraw', idempotency_key: key };
  const spy = vi.spyOn(f.idem, 'abandon');
  try {
    rejected(f, await c.send(body, { token }), 401, code);
    expect(spy).not.toHaveBeenCalled();
    expect(await rows(f, key)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  accepted(f, await c.send(body), abandoned);
});

it('[AC-B1-02g#12] 有效令牌加错误签名 10401，不调用原语；真实签名可作废', async () => {
  const c = await client(f);
  const key = randomUUID();
  const body = { action: 'withdraw', idempotency_key: key };
  const spy = vi.spyOn(f.idem, 'abandon');
  try {
    rejected(f, await c.send(body, { headers: { 'x-sign': '0'.repeat(64) } }), 401, 10401);
    expect(spy).not.toHaveBeenCalled();
    expect(await rows(f, key)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  accepted(f, await c.send(body), abandoned);
});

it('[AC-B1-02g#13] 原语收到令牌主体与 trace，HTTP 状态及 body 字节原样写出', async () => {
  const c = await client(f);
  const key = randomUUID();
  const trace = randomUUID();
  const body = `{ "code":40901, "msg":"仍在处理", "trace_id":"${trace}" }`;
  const spy = vi
    .spyOn(f.idem, 'abandon')
    .mockResolvedValue({ status: 409, body, source: 'idempotency' });
  try {
    const response = await c.send({ action: 'phone_change', idempotency_key: key }, { trace });
    rejected(f, response, 409, 40901);
    expect(response.payload).toBe(body);
    expect(spy).toHaveBeenCalledExactlyOnceWith({
      appId: c.appId,
      userId: c.uid,
      action: 'phone_change',
      key,
      traceId: trace,
    });
  } finally {
    spy.mockRestore();
  }
});

it('[AC-B1-02g#14] 提交结果未知必须断开连接或返回无统一外壳的 500', async () => {
  const c = await client(f);
  const key = randomUUID();
  const spy = vi
    .spyOn(f.idem, 'abandon')
    .mockRejectedValue(new IdempotencyError('outcome_unknown'));
  try {
    const result = await c.send({ action: 'withdraw', idempotency_key: key }).then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'disconnect' as const, error }),
    );
    expect(spy).toHaveBeenCalledOnce();
    if (result.kind === 'disconnect') {
      // light-my-request reports a destroyed reply with this code; arbitrary exceptions fail.
      expect(result.error).toMatchObject({ code: 'LIGHT_ECONNRESET' });
    } else {
      expect(result.response.statusCode).toBe(500);
      let body: unknown = null;
      try {
        body = JSON.parse(result.response.payload);
      } catch {
        /* Plain text is allowed. */
      }
      expect(body).not.toEqual(
        expect.objectContaining({
          code: expect.any(Number),
          msg: expect.any(String),
          trace_id: expect.any(String),
        }),
      );
    }
    expect(await rows(f, key)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it('[AC-B1-02g#15] api 提供作废路由，无 DB 时由签名或令牌守卫拒绝（401）或 50001；admin / stream 不提供', async () => {
  expect(f.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: PATH })).toBe(true);
  const c = await client(f);
  accepted(f, await c.send({ action: 'withdraw', idempotency_key: randomUUID() }), abandoned);
  for (const entry of ['api', 'admin', 'stream'] as const) {
    const app = await entryApp(f, entry);
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const response = await app.inject({
        method: 'POST',
        url: PATH,
        headers: {
          'content-type': 'application/json',
          'x-app-id': 'couli',
          'x-platform': 'ios',
          'x-app-version': '2.0.0',
        },
        payload: JSON.stringify({ action: 'withdraw', idempotency_key: randomUUID() }),
      });
      if (entry === 'api') {
        expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: PATH })).toBe(
          true,
        );
        expect([401, 500]).toContain(response.statusCode);
        if (response.statusCode === 401) {
          expect([10401, 10402, 10001, 10002]).toContain(response.json<{ code: number }>().code);
          expect(f.validators.error(response.json())).toBe(true);
          expect(f.validators.error.errors ?? []).toEqual([]);
        } else expect(response.json()).toMatchObject({ code: 50001 });
      } else {
        expect(response.statusCode).toBe(404);
        expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: PATH })).toBe(
          false,
        );
      }
    } finally {
      await app.close();
    }
  }
  for (const entry of ['admin', 'stream'] as const) {
    const app = await entryApp(f, entry, true);
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: PATH })).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  }
});

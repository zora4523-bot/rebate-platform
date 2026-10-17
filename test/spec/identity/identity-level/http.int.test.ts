import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, acquireTestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BODY, PAYOUT, client, openHttp, refusal, type Fixture } from './http-kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
let f: Fixture;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  redis = await acquireTestRedis();
  f = await openHttp(db, redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    try {
      await redis?.stop();
    } finally {
      try {
        if (db) await destroyDb(db);
      } finally {
        await database?.drop();
      }
    }
  }
});

for (const method of ['GET', 'PUT'] as const) {
  for (const [phone, status, code] of [
    [false, 403, 10005],
    [true, 422, 30304],
  ] as const) {
    it(`[AC-B1-02za#2] 真 AppModule ${method} phone=${phone} → ${code}，业务桩未执行`, async () => {
      const c = await client(f, { phone });
      const trace = randomUUID();
      const response = await c.send(method, PAYOUT, { headers: { 'x-trace-id': trace } });
      await refusal(response, status, code);
      expect(response.json()['trace_id']).toBe(trace);
      expect(f.handled(c.uid)).toBe(0);
    });
  }

  it(`[AC-B1-02za#3] ${method} 封禁优先 10006，解封后未绑手机才返回 10005`, async () => {
    const c = await client(f);
    await c.ban('banned');
    await refusal(await c.send(method), 403, 10006, false);
    await c.ban('normal');
    await refusal(await c.send(method), 403, 10005);
    expect(f.handled(c.uid)).toBe(0);
  });

  it(`[AC-B1-02za#4] ${method} deletion_only 先返回 10405，full 令牌才进入身份等级检查`, async () => {
    const c = await client(f);
    const restricted = await c.accessWithClaims({ scp: 'deletion_only' });
    await refusal(await c.send(method, PAYOUT, { token: restricted }), 403, 10405, false);
    await refusal(await c.send(method), 403, 10005);
    expect(f.handled(c.uid)).toBe(0);
  });

  it(`[AC-B1-02za#5] ${method} 同一令牌绑手机后立即从 10005 变 30304，解绑也立即生效`, async () => {
    const c = await client(f);
    await refusal(await c.send(method), 403, 10005);
    await c.bind(true);
    await refusal(await c.send(method), 422, 30304);
    await c.bind(false);
    await refusal(await c.send(method), 403, 10005);
    expect(f.handled(c.uid)).toBe(0);
  });

  it(`[AC-B1-02za#6] ${method} 合法签名 JWT 的伪造等级字段和请求体不能代替当前库状态`, async () => {
    const c = await client(f);
    const token = await c.accessWithClaims({
      identity_level: 'realname',
      level: 'realname',
      phone_hmac: 'claimed-phone',
      phone_bound: true,
      realname_status: 'verified',
    });
    await refusal(
      await c.send(method, PAYOUT, {
        token,
        body: {
          ...BODY,
          app_id: 'other',
          user_id: randomUUID(),
          phone_hmac: 'claimed-phone',
          realname_status: 'verified',
        },
      }),
      403,
      10005,
    );
    await c.bind(true);
    await refusal(await c.send(method, PAYOUT, { token }), 422, 30304);
    expect(f.handled(c.uid)).toBe(0);
  });

  for (const [phone, status, code] of [
    [false, 403, 10005],
    [true, 422, 30304],
  ] as const) {
    it(`[AC-B1-02za#7] ${method} 限流桶确已满时仍先返回 ${code}`, async () => {
      const c = await client(f, {
        phone,
        config: {
          'rate_limit.ops': {
            getMe: 'b1_02za',
            getPayoutAccount: 'b1_02za',
            savePayoutAccount: 'b1_02za',
          },
          'rate_limit.b1_02za': { user: [{ limit: 1, window_sec: 3600 }] },
        },
      });
      const first = await c.send('GET', '/v1/me');
      expect(first.statusCode, first.payload).toBe(200);
      expect(first.json()['code']).toBe(0);
      await refusal(await c.send('GET', '/v1/me'), 429, 42901, false);
      await refusal(await c.send(method), status, code);
      expect(f.handled(c.uid)).toBe(0);
    });
  }
}

it('[AC-B1-02za#8] PUT 低版本 10405 优先；升级后进入 10005 而不是 step-up 10003', async () => {
  const c = await client(f, { minVersion: '2.0.0' });
  await refusal(await c.send('PUT', PAYOUT, { version: '1.0.0' }), 403, 10405, false);
  await refusal(await c.send('PUT'), 403, 10005);
  expect(f.handled(c.uid)).toBe(0);
});

for (const [phone, status, code] of [
  [false, 403, 10005],
  [true, 422, 30304],
] as const) {
  it(`[AC-B1-02za#9] PUT ${code} 既不要求也不预占 step_up_token（不是预占后释放）`, async () => {
    const c = await client(f, { phone });
    const step = await c.stepUp();
    const key = randomUUID();
    await refusal(await c.send('PUT', PAYOUT, { key }), status, code);
    await refusal(await c.send('PUT', PAYOUT, { key, stepUp: step.token }), status, code);
    expect(f.stepUpCalls).not.toContain(step.jti);
    expect(await f.redis.namespace('step_up').get(step.jti)).toBeNull();
    expect(f.handled(c.uid)).toBe(0);
  });
}

it('[AC-B1-02za#10] PUT 已保存结果按同键原样回放，不因当前未绑手机或缺少 step-up 改判', async () => {
  const c = await client(f);
  const key = randomUUID();
  const trace = randomUUID();
  // No HTTP request scope: the primitive is also used by jobs, so no identity gate here.
  const original = await f.idem.executeInTransaction(
    {
      appId: c.appId,
      actor: { userId: c.uid, deviceId: null, phoneHmac: null },
      method: 'PUT',
      path: PAYOUT,
      key,
      body: BODY,
      traceId: trace,
    },
    async () => ({ status: 422, envelope: { code: 30304, msg: '未实名', trace_id: trace } }),
  );
  const replay = await c.send('PUT', PAYOUT, { key, headers: { 'x-trace-id': trace } });
  expect(replay.statusCode).toBe(422);
  expect(replay.json()).toEqual(JSON.parse(original.body));
  expect(f.handled(c.uid)).toBe(0);
  // A fresh key proves that the real identity check is wired, and keeps this test red on baseline.
  await refusal(await c.send('PUT'), 403, 10005);
});

it('[AC-B1-02za#11] login 级 GET /v1/me 对未绑手机用户 200，realname 级 GET 才回 10005', async () => {
  const c = await client(f);
  const me = await c.send('GET', '/v1/me');
  expect(me.statusCode, me.payload).toBe(200);
  expect(me.json()['code']).toBe(0);
  await refusal(await c.send('GET'), 403, 10005);
});

it('[AC-B1-02za#21] PUT 首次 30304 必须保存，同键保持原结果，新键才按当前手机号判定', async () => {
  const c = await client(f, { phone: true });
  const key = randomUUID();
  const first = await c.send('PUT', PAYOUT, { key });
  await refusal(first, 422, 30304);
  const rows = await db
    .withSchema('app')
    .selectFrom('idempotency_keys')
    .select(['status', 'response'])
    .where('app_id', '=', c.appId)
    .where('key', '=', key)
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'completed' });
  await c.bind(false);
  const replay = await c.send('PUT', PAYOUT, { key });
  expect(replay.statusCode).toBe(422);
  expect(replay.json()).toEqual(first.json());
  await refusal(await c.send('PUT'), 403, 10005);
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-02za#12] ①签名、②令牌、③App 越权和④缺少幂等键均先于身份检查', async () => {
  const c = await client(f);
  await refusal(await c.send('PUT', PAYOUT, { headers: { 'x-sign': '0'.repeat(64) } }), 401, 10401);
  await refusal(await c.send('PUT', PAYOUT, { token: 'not-a-jwt' }), 401, 10002);
  const otherApp = await c.accessWithClaims({ app_id: 'different_app' });
  await refusal(await c.send('PUT', PAYOUT, { token: otherApp }), 403, 10403);
  await refusal(await c.send('PUT', PAYOUT, { key: null }), 400, 20001, false);
  await refusal(await c.send('PUT'), 403, 10005);
});

it('[AC-B1-02za#22] ④冲突键 20901 和作废键 20903 不被 10005 覆盖，新键才检查等级', async () => {
  const c = await client(f);
  const key = randomUUID();
  const trace = randomUUID();
  await f.idem.executeInTransaction(
    {
      appId: c.appId,
      actor: { userId: c.uid, deviceId: null, phoneHmac: null },
      method: 'PUT',
      path: PAYOUT,
      key,
      body: BODY,
      traceId: trace,
    },
    async () => ({
      status: 200,
      envelope: { code: 0, msg: '', data: { fixture: true }, trace_id: trace },
    }),
  );
  await refusal(
    await c.send('PUT', PAYOUT, { key, body: { fixture: 'different-body' } }),
    409,
    20901,
    false,
  );
  const abandonedKey = randomUUID();
  const abandoned = await f.idem.abandon({
    appId: c.appId,
    userId: c.uid,
    action: 'payout_account_change',
    key: abandonedKey,
    traceId: randomUUID(),
  });
  expect(abandoned.status).toBe(200);
  await refusal(await c.send('PUT', PAYOUT, { key: abandonedKey }), 409, 20903, false);
  await refusal(await c.send('PUT'), 403, 10005);
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-02za#23] ④正在处理的同键返回 40901，不提前执行身份检查', async () => {
  const c = await client(f);
  const key = randomUUID();
  const trace = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = f.idem.executeInTransaction(
    {
      appId: c.appId,
      actor: { userId: c.uid, deviceId: null, phoneHmac: null },
      method: 'PUT',
      path: PAYOUT,
      key,
      body: BODY,
      traceId: trace,
    },
    async () => {
      entered.resolve();
      await release.promise;
      return {
        status: 200,
        envelope: { code: 0, msg: '', data: { fixture: true }, trace_id: trace },
      };
    },
  );
  // Forward setup failure instead of hanging until the test timeout.
  void pending.catch((error: unknown) => entered.reject(error));
  try {
    await entered.promise;
    await refusal(await c.send('PUT', PAYOUT, { key }), 409, 40901, false);
  } finally {
    release.resolve();
    await pending;
  }
  await refusal(await c.send('PUT'), 403, 10005);
  expect(f.handled(c.uid)).toBe(0);
});

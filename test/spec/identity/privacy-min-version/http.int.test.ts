import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AppealsService } from '../../../../apps/api/src/modules/risk/application/appeals.ts';
import {
  BODY,
  PAYOUT,
  client,
  openHttp,
  refusal,
  type Fixture,
  type Response,
} from '../identity-level/http-kit.ts';
import { consent, MIN_KEY, NOW, noKey, ROOT } from './kit.ts';

// Production AppModule and both production guard lists are left intact. The existing fixture
// observes payout business and Redis step-up reservations, with positive controls at startup.
// Appeals probes observe the actual application service, after the idempotency post-miss chain.
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let f: Fixture;
let appeals: AppealsService;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  redis = await acquireTestRedis();
  f = await openHttp(db, redis.url);
  const module = (await import(
    new URL('apps/api/src/modules/risk/http/public/appeals.controller.ts', ROOT).href
  )) as { APPEALS_SERVICE: symbol };
  appeals = f.app.get<AppealsService>(module.APPEALS_SERVICE);
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

const APPEALS = '/v1/me/appeals';
const APPEAL = { target_type: 'account', content: '合成申诉，请复核' };
async function subject(options: Parameters<typeof client>[1] = {}) {
  const c = await client(f, {
    ...options,
    config: {
      [MIN_KEY]: 3,
      'legal.privacy.version': 5,
      'legal.agreement.version': 1,
      h5_base_url: 'https://h5.example.test/',
      'h5_release.stable': 'stable-v1',
      kf: { url: 'https://kf.example.test/chat' },
      ...options.config,
    },
  });
  await consent(db, c.appId, c.uid, { version: 2, at: '2026-10-17T01:00:00Z' });
  return c;
}
async function privacy(response: Response, trace?: string) {
  await refusal(response, 403, 10004, false);
  expect(response.json()).toMatchObject({
    code: 10004,
    msg: '请先阅读并同意相关授权',
    data: { consent_type: 'privacy' },
    ...(trace === undefined ? {} : { trace_id: trace }),
  });
  expect(response.json()['data']).toEqual({ consent_type: 'privacy' });
}
async function accept(c: Awaited<ReturnType<typeof client>>) {
  const result = await c.send('POST', '/v1/consents', {
    body: {
      type: 'privacy',
      version: 3,
      accepted: true,
      channel: 'privacy_center',
      client_at: NOW,
    },
  });
  expect(result.statusCode, result.payload).toBe(200);
  expect(result.json()['code']).toBe(0);
  expect(
    await db
      .withSchema('app')
      .selectFrom('consent_records')
      .select(['subject_type', 'accepted', 'version'])
      .where('app_id', '=', c.appId)
      .where('user_id', '=', c.uid)
      .where('type', '=', 'privacy')
      .orderBy('server_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst(),
  ).toEqual({
    subject_type: 'user',
    accepted: true,
    version: 3,
  });
}

for (const method of ['GET', 'POST'] as const) {
  it(`[AC-B1-02zh#11] login ${method} 真 HTTP 返回契约 403/10004，业务不执行，10004 不留幂等记录`, async () => {
    const c = await subject();
    const trace = randomUUID();
    const key = randomUUID();
    const probe = vi.spyOn(appeals, method === 'GET' ? 'list' : 'submit');
    try {
      await privacy(
        await c.send(method, APPEALS, {
          body: APPEAL,
          key,
          headers: { 'x-trace-id': trace },
        }),
        trace,
      );
      expect(probe).not.toHaveBeenCalled();
      await noKey(db, c.appId, key);
      // Positive control: the same observed service is reachable once consent is current.
      await accept(c);
      const next = await c.send(method, APPEALS, { body: APPEAL, key });
      expect(next.json()['code']).toBe(method === 'GET' ? 0 : 20001);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  });
}

it('[AC-B1-02zh#12] GET /me 被拦，optional 同意带令牌写用户记录后立即放行，不要求最新展示版本', async () => {
  const c = await subject();
  await privacy(await c.send('GET', '/v1/me'));
  await accept(c);
  const me = await c.send('GET', '/v1/me');
  expect(me.statusCode, me.payload).toBe(200);
  expect(me.json()['data']).toMatchObject({ need_reconsent: true });
});

it('[AC-B1-02zh#13] POST 同键第一次 10004、重新同意后正常受理；封禁白名单仍须过隐私', async () => {
  const c = await subject();
  await c.ban('banned');
  const key = randomUUID();
  await privacy(await c.send('POST', APPEALS, { body: APPEAL, key }));
  await noKey(db, c.appId, key);
  // Stage ⑤ currently has no /consents ban exemption. Seed the new consent here to isolate
  // stage ⑦ on the appeals whitelist; the non-banned cases exercise real POST /consents.
  await consent(db, c.appId, c.uid, { version: 3 });
  const result = await c.send('POST', APPEALS, { body: APPEAL, key });
  expect(result.statusCode, result.payload).toBe(200);
  expect(result.json()['code']).toBe(0);
  expect(
    await db
      .withSchema('app')
      .selectFrom('idempotency_keys')
      .select('status')
      .where('app_id', '=', c.appId)
      .where('key', '=', key)
      .execute(),
  ).toEqual([{ status: 'completed' }]);
});

for (const method of ['GET', 'PUT'] as const) {
  it(`[AC-B1-02zh#14] ${method} ⑤封禁先于隐私；封禁白名单 /me 仍返回 10004`, async () => {
    const c = await subject();
    await c.ban('banned');
    await refusal(await c.send(method), 403, 10006, false);
    await privacy(await c.send('GET', '/v1/me'));
    expect(f.handled(c.uid)).toBe(0);
  });

  it(`[AC-B1-02zh#15] ${method} ④a${method === 'PUT' ? '版本与' : ''}受限作用域先于隐私`, async () => {
    const c = await subject({ minVersion: '2.0.0' });
    if (method === 'PUT') {
      await refusal(await c.send(method, PAYOUT, { version: '1.0.0' }), 403, 10405, false);
    }
    const restricted = await c.accessWithClaims({ scp: 'deletion_only' });
    await refusal(await c.send(method, PAYOUT, { token: restricted }), 403, 10405, false);
    await privacy(await c.send(method));
    expect(f.handled(c.uid)).toBe(0);
  });

  for (const phone of [false, true]) {
    it(`[AC-B1-02zh#16] ${method} 隐私先于 ${phone ? '30304' : '10005'}，业务不执行`, async () => {
      const c = await subject({ phone });
      await privacy(await c.send(method));
      await accept(c);
      await refusal(await c.send(method), phone ? 422 : 403, phone ? 30304 : 10005);
      expect(f.handled(c.uid)).toBe(0);
    });
  }

  it(`[AC-B1-02zh#17] ${method} 限流桶确已满仍先返回隐私 10004`, async () => {
    const c = await subject({
      config: {
        'rate_limit.ops': {
          getMe: 'b1_02zh',
          getPayoutAccount: 'b1_02zh',
          savePayoutAccount: 'b1_02zh',
        },
        'rate_limit.b1_02zh': { user: [{ limit: 1, window_sec: 3600 }] },
      },
    });
    await accept(c);
    expect((await c.send('GET', '/v1/me')).statusCode).toBe(200);
    await refusal(await c.send('GET', '/v1/me'), 429, 42901, false);
    await consent(db, c.appId, c.uid, { accepted: false, version: 9, at: '2026-10-17T02:00:01Z' });
    await privacy(await c.send(method));
    expect(f.handled(c.uid)).toBe(0);
  });
}

it('[AC-B1-02zh#18] 隐私先于 step-up，既不预占也不核销令牌、后续业务未执行', async () => {
  const c = await subject({ phone: true });
  await c.verifyRealname();
  const step = await c.stepUp();
  const key = randomUUID();
  await privacy(await c.send('PUT', PAYOUT, { key }));
  await privacy(await c.send('PUT', PAYOUT, { key, stepUp: step.token }));
  expect(f.stepUpCalls).not.toContain(step.jti);
  expect(await f.redis.namespace('step_up').get(step.jti)).toBeNull();
  await noKey(db, c.appId, key);
  expect(f.handled(c.uid)).toBe(0);
  await accept(c);
  await refusal(await c.send('PUT', PAYOUT, { key }), 403, 10003);
});

it('[AC-B1-02zh#19] ①签名、②令牌、③app越权优先；正常身份才返回隐私拒绝', async () => {
  const c = await subject();
  await refusal(await c.send('PUT', PAYOUT, { headers: { 'x-sign': '0'.repeat(64) } }), 401, 10401);
  await refusal(await c.send('PUT', PAYOUT, { token: 'not-a-jwt' }), 401, 10002);
  await refusal(await c.send('PUT', PAYOUT, { headers: { 'x-app-id': 'other-app' } }), 403, 10403);
  await privacy(await c.send('PUT'));
});

it('[AC-B1-02zh#20] ④回放、参数冲突与作废键都先于隐私，不改写已保存响应', async () => {
  const c = await subject();
  const key = randomUUID();
  const trace = randomUUID();
  const result = await f.idem.executeInTransaction(
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
  const replay = await c.send('PUT', PAYOUT, { key });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(JSON.parse(result.body));
  await refusal(
    await c.send('PUT', PAYOUT, {
      key,
      body: { ...BODY, alipay_logon_id: 'different@example.com' },
    }),
    409,
    20901,
    false,
  );
  const abandoned = randomUUID();
  expect(
    (
      await f.idem.abandon({
        appId: c.appId,
        userId: c.uid,
        action: 'payout_account_change',
        key: abandoned,
        traceId: trace,
      })
    ).status,
  ).toBe(200);
  await refusal(await c.send('PUT', PAYOUT, { key: abandoned }), 409, 20903, false);
  await privacy(await c.send('PUT'));
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-02zh#21] ④同键正在处理先返回 40901，新键才返回 10004', async () => {
  const c = await subject();
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
      return { status: 200, envelope: { code: 0, msg: '', data: {}, trace_id: trace } };
    },
  );
  void pending.catch((error: unknown) => entered.reject(error));
  try {
    await entered.promise;
    await refusal(await c.send('PUT', PAYOUT, { key }), 409, 40901, false);
  } finally {
    release.resolve();
    await pending;
  }
  await privacy(await c.send('PUT'));
});

for (const route of ['refresh', 'config', 'logout'] as const) {
  it(`[AC-B1-02zh#22] ${route} 放行，先证明同一会话在 /me 确被隐私拦截`, async () => {
    const c = await subject();
    await privacy(await c.send('GET', '/v1/me'));
    const result =
      route === 'config'
        ? await c.send('GET', '/v1/config')
        : await c.send('POST', `/v1/auth/${route}`, {
            body: route === 'refresh' ? { refresh_token: c.session.refresh_token } : {},
          });
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json()['code']).toBe(0);
  });
}

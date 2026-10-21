// Real AppModule (B1-15e §9.2 #3: app.module wires stage ⑥ first in RiskModule's two lists). The
// identity-level fixture observes the payout business, Redis step-up reservations and starts with
// a positive control (a phone-bound, real-name-verified user reaches the business). HTTP level uses
// live routes only; planned /v1/me/deletion* routes are proven in checks.int.test.ts.
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
import { consent, MIN_KEY } from '../privacy-min-version/kit.ts';
import { MSG, NOW, ROOT, cancel, deletion, noKey, userStatus } from './kit.ts';

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

// http-kit's Method type predates PATCH; the request still goes out as PATCH (signed as such).
const PATCH = 'PATCH' as 'POST';
const ME = '/v1/me';
const NICK = { nickname: '冷静期改名' };
const APPEALS = '/v1/me/appeals';
const APPEAL = { target_type: 'account', content: '合成申诉，请复核' };
// Configuration GET /v1/me and POST /v1/consents read (as B1-02zh's subjects); no privacy minimum.
const BASE = {
  'legal.privacy.version': 5,
  'legal.agreement.version': 1,
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
};
type Client = Awaited<ReturnType<typeof client>>;

async function subject(options: Parameters<typeof client>[1] = {}, realname = false) {
  const c = await client(f, { ...options, config: { ...BASE, ...options.config } });
  if (realname) await c.verifyRealname();
  return c;
}
function stage(c: Client, status: 'cooling' | 'processing' | 'done' | 'cancelled', at?: string) {
  return deletion(db, c.appId, c.uid, status, at ?? f.clock.now());
}
async function refused(response: Response, expected: 'cooling' | 'processing', trace?: string) {
  await refusal(response, 403, 10007, false);
  expect(response.json()).toEqual({
    code: 10007,
    msg: MSG,
    data: { stage: expected },
    trace_id: trace ?? expect.any(String),
  });
}
async function nickname(c: Client) {
  const row = await db
    .withSchema('app')
    .selectFrom('users')
    .select('nickname')
    .where('app_id', '=', c.appId)
    .where('id', '=', c.uid)
    .executeTakeFirstOrThrow();
  return row.nickname;
}
/** A phone-bound, real-name-verified client with a fresh step-up reaches the payout business. */
async function passes(c: Client) {
  const before = f.handled(c.uid);
  const step = await c.stepUp();
  const result = await c.send('PUT', PAYOUT, { stepUp: step.token });
  expect(result.json()['code'], result.payload).not.toBe(10007);
  expect(f.handled(c.uid), result.payload).toBe(before + 1);
}
async function ok(response: Response) {
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.json()['code'], response.payload).toBe(0);
}

it('[AC-B1-15e#2] cooling 用户非幂等 PATCH /v1/me → 403 10007 stage=cooling，trace_id 同请求，处理器未执行', async () => {
  const c = await subject();
  const before = await nickname(c);
  await stage(c, 'cooling');
  const trace = randomUUID();
  const key = randomUUID();
  await refused(
    await c.send(PATCH, ME, { body: NICK, key, headers: { 'x-trace-id': trace } }),
    'cooling',
    trace,
  );
  expect(await nickname(c)).toBe(before);
  await noKey(db, c.appId, key);
});

it('[AC-B1-15e#2] cooling 用户幂等 PUT 收款账号 → 10007：业务未执行、幂等表无记录、step_up_token 未核销', async () => {
  const c = await subject({ phone: true }, true);
  const rid = await stage(c, 'cooling');
  const trace = randomUUID();
  const key = randomUUID();
  const step = await c.stepUp();
  await refused(
    await c.send('PUT', PAYOUT, { key, stepUp: step.token, headers: { 'x-trace-id': trace } }),
    'cooling',
    trace,
  );
  expect(f.handled(c.uid)).toBe(0);
  expect(f.stepUpCalls).not.toContain(step.jti);
  expect(await f.redis.namespace('step_up').get(step.jti)).toBeNull();
  await noKey(db, c.appId, key);
  // Positive control: once withdrawn, the same user reaches the business at once.
  await cancel(db, rid, f.clock.now());
  await passes(c);
});

for (const status of ['cooling', 'processing', 'deleting'] as const) {
  it(`[AC-B1-15e#3] ${status} 用户经 HTTP 的白名单逐项放行：GET /v1/me、GET /v1/invites/me、consents、abandon、refresh、logout`, async () => {
    const c = await subject();
    if (status === 'deleting') await userStatus(db, c.appId, c.uid, 'deleting');
    else await stage(c, status);
    // Positive control: this session is refused on a write outside the whitelist.
    await refused(
      await c.send(PATCH, ME, { body: NICK }),
      status === 'cooling' ? 'cooling' : 'processing',
    );
    await ok(await c.send('GET', ME));
    const invites = await c.send('GET', '/v1/invites/me');
    expect(invites.statusCode, invites.payload).not.toBe(403);
    expect(invites.json()['code'], invites.payload).not.toBe(10007);
    await ok(
      await c.send('POST', '/v1/consents', {
        body: {
          type: 'privacy',
          version: 5,
          accepted: true,
          channel: 'privacy_center',
          client_at: NOW,
        },
      }),
    );
    const abandoned = await c.send('POST', '/v1/idempotency-keys/abandon', {
      key: null,
      body: { action: 'payout_account_change', idempotency_key: randomUUID() },
    });
    await ok(abandoned);
    expect(abandoned.json()['data']).toEqual({ outcome: 'abandoned', original: null });
    const refreshed = await c.send('POST', '/v1/auth/refresh', {
      body: { refresh_token: c.session.refresh_token },
    });
    await ok(refreshed);
    // Logout last, with the refreshed access token (rotation may retire the old one).
    const token = refreshed.json<{ data: { access_token: string } }>().data.access_token;
    await ok(await c.send('POST', '/v1/auth/logout', { body: {}, token }));
  });
}

for (const [label, seed] of [
  ['users.status=deleting（无单）', 'deleting'],
  ['processing 单', 'processing'],
  ['done 单的残留会话', 'done'],
] as const) {
  it(`[AC-B1-15e#4] ${label} 写接口 → 10007 stage=processing，GET 仍放行`, async () => {
    const c = await subject({ phone: true }, true);
    if (seed === 'deleting') await userStatus(db, c.appId, c.uid, 'deleting');
    else await stage(c, seed);
    await refused(await c.send(PATCH, ME, { body: NICK }), 'processing');
    const step = await c.stepUp();
    await refused(await c.send('PUT', PAYOUT, { stepUp: step.token }), 'processing');
    expect(f.handled(c.uid)).toBe(0);
    await ok(await c.send('GET', ME));
  });
}

it('[AC-B1-15e#5] 只有 cancelled 单放行；cancelled 历史加新 cooling → 10007；冷静期已过的 cooling 单仍 cooling', async () => {
  const c = await subject({ phone: true }, true);
  await stage(c, 'cancelled', '2026-09-01T00:00:00Z');
  await passes(c);
  const rid = await stage(c, 'cooling');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
  await cancel(db, rid, f.clock.now());
  await passes(c);
  // Applied 8 days before the fixture clock: the window has passed, the job has not run.
  await stage(c, 'cooling', '2026-10-09T02:00:00Z');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
});

it('[AC-B1-15e#6] 封禁加冷静期只返回 10006；解封后同一请求返回 10007', async () => {
  const c = await subject();
  await stage(c, 'cooling');
  await c.ban('banned');
  await refusal(await c.send(PATCH, ME, { body: NICK }), 403, 10006, false);
  await refusal(await c.send('PUT', PAYOUT), 403, 10006, false);
  await c.ban('normal');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
});

it('[AC-B1-15e#6] ⑤ 白名单内的申诉对冷静期用户继续到 ⑥ 得 10007，申诉未受理、不留幂等记录', async () => {
  const c = await subject();
  await c.ban('banned');
  const rid = await stage(c, 'cooling');
  const key = randomUUID();
  const probe = vi.spyOn(appeals, 'submit');
  try {
    await refused(await c.send('POST', APPEALS, { body: APPEAL, key }), 'cooling');
    expect(probe).not.toHaveBeenCalled();
    await noKey(db, c.appId, key);
    // Positive control: withdrawn, the same key is accepted by the observed service.
    await cancel(db, rid, f.clock.now());
    await ok(await c.send('POST', APPEALS, { body: APPEAL, key }));
    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    probe.mockRestore();
  }
});

it('[AC-B1-15e#6] 冷静期加隐私同意低于最低版 → 10007；白名单写接口照常再过 ⑦', async () => {
  const c = await subject({ phone: true, config: { [MIN_KEY]: 3 } }, true);
  await consent(db, c.appId, c.uid, { version: 2, at: '2026-10-17T01:00:00Z' });
  const rid = await stage(c, 'cooling');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
  const step = await c.stepUp();
  await refused(await c.send('PUT', PAYOUT, { stepUp: step.token }), 'cooling');
  // abandon is inside ⑥'s whitelist but not ⑦'s exemption.
  await refusal(
    await c.send('POST', '/v1/idempotency-keys/abandon', {
      key: null,
      body: { action: 'payout_account_change', idempotency_key: randomUUID() },
    }),
    403,
    10004,
    false,
  );
  await cancel(db, rid, f.clock.now());
  await refusal(await c.send(PATCH, ME, { body: NICK }), 403, 10004, false);
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-15e#6] ④a 版本与受限作用域 10405 先于 10007', async () => {
  const c = await subject({ minVersion: '2.0.0' });
  await stage(c, 'cooling');
  await refusal(await c.send(PATCH, ME, { body: NICK, version: '1.0.0' }), 403, 10405, false);
  await refusal(await c.send('PUT', PAYOUT, { version: '1.0.0' }), 403, 10405, false);
  const restricted = await c.accessWithClaims({ scp: 'deletion_only' });
  await refusal(await c.send(PATCH, ME, { body: NICK, token: restricted }), 403, 10405, false);
  await refusal(await c.send('PUT', PAYOUT, { token: restricted }), 403, 10405, false);
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-15e#6] ④ 回放、参数冲突与作废键先于 10007，新键才返回 10007', async () => {
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
  await stage(c, 'cooling');
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
  await refusal(await c.send('PUT', PAYOUT, { key: abandoned }), 409, 20903, false);
  await refused(await c.send('PUT', PAYOUT), 'cooling');
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-15e#6] ④ 同键正在处理先返回 40901，新键才返回 10007', async () => {
  const c = await subject();
  await stage(c, 'cooling');
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
  await refused(await c.send('PUT', PAYOUT), 'cooling');
});

for (const [label, phone, realname, expected] of [
  ['30304（未绑手机）', false, false, 30304],
  ['10005（未实名）', true, false, 10005],
  ['10003（缺 step-up）', true, true, 10003],
] as const) {
  it(`[AC-B1-15e#6] 10007 先于 ${label}，业务未执行；撤回后才返回 ${expected}`, async () => {
    const c = await subject({ phone }, realname);
    const rid = await stage(c, 'cooling');
    await refused(await c.send('PUT', PAYOUT), 'cooling');
    expect(f.handled(c.uid)).toBe(0);
    await cancel(db, rid, f.clock.now());
    const after = await c.send('PUT', PAYOUT);
    expect(after.json()['code'], after.payload).toBe(expected);
    expect(f.handled(c.uid)).toBe(0);
  });
}

it('[AC-B1-15e#6] 限流桶确已满仍先返回 10007', async () => {
  const c = await subject(
    {
      phone: true,
      config: {
        'rate_limit.ops': { getMe: 'b1_15e', updateMe: 'b1_15e', savePayoutAccount: 'b1_15e' },
        'rate_limit.b1_15e': { user: [{ limit: 1, window_sec: 3600 }] },
      },
    },
    true,
  );
  await stage(c, 'cooling');
  await ok(await c.send('GET', ME));
  await refusal(await c.send('GET', ME), 429, 42901, false);
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
  const step = await c.stepUp();
  await refused(await c.send('PUT', PAYOUT, { stepUp: step.token }), 'cooling');
  expect(f.handled(c.uid)).toBe(0);
});

it('[AC-B1-15e#7] 不缓存：插入 cooling 后下一次请求立即 10007，撤回后下一次立即放行', async () => {
  const c = await subject({ phone: true }, true);
  await passes(c);
  const rid = await stage(c, 'cooling');
  const step = await c.stepUp();
  await refused(await c.send('PUT', PAYOUT, { stepUp: step.token }), 'cooling');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'cooling');
  await cancel(db, rid, f.clock.now());
  await passes(c);
  await userStatus(db, c.appId, c.uid, 'deleting');
  await refused(await c.send(PATCH, ME, { body: NICK }), 'processing');
});

it('[AC-B1-15e#8] 只看令牌主体：A 冷静期不影响 B，请求头伪造对方 user_id 不起作用', async () => {
  const a = await subject({ phone: true }, true);
  const b = await subject({ phone: true }, true);
  await stage(a, 'cooling');
  const before = f.handled(b.uid);
  const step = await b.stepUp();
  const result = await b.send('PUT', PAYOUT, {
    stepUp: step.token,
    headers: { 'x-user-id': a.uid },
  });
  expect(result.json()['code'], result.payload).not.toBe(10007);
  expect(f.handled(b.uid)).toBe(before + 1);
  await refused(await a.send('PUT', PAYOUT, { headers: { 'x-user-id': b.uid } }), 'cooling');
});

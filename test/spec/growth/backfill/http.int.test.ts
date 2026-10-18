import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, acquireTestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  CODE,
  OTHER_CODE,
  withHttp,
  seed,
  client,
  answer,
  row,
  logs,
  idem,
  config,
  callsFor,
  count,
  type Fixture,
} from './http-kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase(); // Isolated test database; global setup decides where.
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  redis = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  try {
    await redis?.stop();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});
const http = (run: (f: Fixture) => Promise<void>) => withHttp(db, redis.url, run);

it('[AC-B1-11e#1] 真 AppModule 成功：原始码交给 backfill 核心，事务内一次绑定并返回 EmptyResponse', async () => {
  await http(async (f) => {
    const parent = await seed(f, CODE);
    const c = await client(f);
    const before = await row(f, c.uid);
    const rawCode = '　ｋ７ｑ２ｍｚ\u200b ';
    const response = await c.post({ invite_code: rawCode });
    const body = answer(f, response);
    expect(response.headers['x-trace-id']).toBe(body.trace_id);
    expect(callsFor(f, c.uid)).toEqual([
      {
        transactional: true,
        command: {
          app_id: c.appId,
          user_id: c.uid,
          device_id: c.deviceId,
          channel: 'backfill',
          invite_code: rawCode,
        },
      },
    ]);
    expect(await row(f, c.uid)).toMatchObject({
      parent_id: parent,
      self_bind_used: true,
      parent_bind_source: 'backfill',
      parent_bound_at: new Date(NOW),
      row_version: before.row_version + 1,
    });
    const written = await logs(f, c.uid);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      app_id: c.appId,
      user_id: c.uid,
      from_parent_id: null,
      to_parent_id: parent,
      source: 'backfill',
      operator: `user:${c.uid}`,
      reason: null,
      at: new Date(NOW),
    });
  });
});

// Inject only the binder result here: distinguish HTTP mapping from core rule tests B1-11d.
for (const code of [10005, 30401, 30402, 30403, 30404, 30408, 30409, 42901, 50001] as const) {
  it(`[AC-B1-11e#2] binder ${code} 原样映射；仅 0/3xxxx 保存，其他结果同键可重试`, async () => {
    await http(async (f) => {
      await seed(f, CODE);
      const c = await client(f);
      const before = await row(f, c.uid);
      const key = randomUUID();
      f.forced.set(c.uid, {
        result: 'failed',
        code,
        ...(code === 42901 ? { retry_after_seconds: 1234 } : {}),
      });
      const first = await c.post(undefined, { key });
      const original = answer(f, first, code);
      if (code === 30401) expect(original.msg).toBe('邀请码无效');
      if (code === 30403) expect(original.msg).toBe('不能绑定该邀请人');
      if (code === 42901) expect(String(first.headers['retry-after'])).toBe('1234');
      else expect(first.headers['retry-after']).toBeUndefined();
      expect(await row(f, c.uid)).toEqual(before);
      expect(await logs(f, c.uid)).toEqual([]);
      expect(callsFor(f, c.uid)).toHaveLength(1);
      f.forced.delete(c.uid);
      if (code >= 30000 && code <= 39999) {
        expect(await idem(f, key)).toMatchObject([{ status: 'completed' }]);
        const replay = await c.post(undefined, { key });
        expect(answer(f, replay, code)).toEqual(original);
        expect(callsFor(f, c.uid)).toHaveLength(1);
        answer(f, await c.post());
      } else {
        expect(await idem(f, key)).toEqual([]);
        answer(f, await c.post(undefined, { key }));
      }
      expect(callsFor(f, c.uid)).toHaveLength(2);
      expect(await logs(f, c.uid)).toHaveLength(1);
    });
  });
}

it('[AC-B1-11e#3] phone 守卫先于开关与 binder；10005 不存键，绑手机后同键能成功', async () => {
  await http(async (f) => {
    await seed(f, CODE);
    const c = await client(f, { phone: false });
    const key = randomUUID();
    await config(f, 'growth.invite_bind.enabled', false);
    answer(f, await c.post(undefined, { key }), 10005);
    expect(callsFor(f, c.uid)).toEqual([]);
    expect(await idem(f, key)).toEqual([]);
    await f.db
      .updateTable('users')
      .set({ phone_hmac: randomBytes(32).toString('hex') })
      .where('id', '=', c.uid)
      .execute();
    await config(f, 'growth.invite_bind.enabled', true);
    answer(f, await c.post(undefined, { key }));
    expect(callsFor(f, c.uid)).toHaveLength(1);
  });
});

for (const scenario of [
  'empty',
  'missing',
  'unavailable',
  'used',
  'self',
  'expired',
  'child',
  'disabled',
  'bad-config',
] as const) {
  it(`[AC-B1-11e#4] 已装配真实核心的 ${scenario} 失败按契约回且不改归属`, async () => {
    await http(async (f) => {
      const parent = await seed(f, CODE, { phone: scenario !== 'unavailable' });
      const c = await client(f);
      let code = 30401;
      let invite = CODE;
      if (scenario === 'empty') invite = ' \u200b　';
      if (scenario === 'missing') invite = OTHER_CODE;
      if (scenario === 'used') {
        code = 30402;
        await f.db
          .updateTable('users')
          .set({ self_bind_used: true })
          .where('id', '=', c.uid)
          .execute();
      }
      if (scenario === 'self') {
        code = 30403;
        invite = 'A2B3C4';
      }
      if (scenario === 'expired') {
        code = 30404;
        await f.db
          .updateTable('users')
          .set({ created_at: new Date('2031-04-29T09:00:00Z') })
          .where('id', '=', c.uid)
          .execute();
      }
      if (scenario === 'child') {
        code = 30409;
        await f.db
          .updateTable('users')
          .set({
            parent_id: c.uid,
            self_bind_used: true,
            parent_bind_source: 'register',
            parent_bound_at: new Date(NOW),
          })
          .where('id', '=', parent)
          .execute();
      }
      if (scenario === 'disabled') {
        code = 30408;
        await config(f, 'growth.invite_bind.enabled', false);
      }
      if (scenario === 'bad-config') {
        code = 50001;
        await config(f, 'invite.backfill_hours', -1);
      }
      const before = await row(f, c.uid);
      const result = answer(f, await c.post({ invite_code: invite }), code);
      if (code === 30401) expect(result.msg).toBe('邀请码无效');
      expect(await row(f, c.uid)).toEqual(before);
      expect(await logs(f, c.uid)).toEqual([]);
      expect(callsFor(f, c.uid)).toHaveLength(1);
      expect(callsFor(f, c.uid)[0]?.transactional).toBe(true);
    });
  });
}

it('[AC-B1-11e#5] 30401 同键回放不再计数、不调 binder；第六个不同键返回 42901 和次日秒数', async () => {
  await http(async (f) => {
    const c = await client(f);
    const key = randomUUID();
    const body = { invite_code: '' };
    const original = answer(f, await c.post(body, { key }), 30401);
    for (let index = 0; index < 6; index += 1) {
      expect(answer(f, await c.post(body, { key }), 30401)).toEqual(original);
    }
    expect(callsFor(f, c.uid)).toHaveLength(1);
    expect(await count(f, c.uid)).toBe('1');
    for (let index = 0; index < 4; index += 1) answer(f, await c.post(body), 30401);
    expect(await count(f, c.uid)).toBe('5');
    const limitedKey = randomUUID();
    const limited = await c.post(body, { key: limitedKey });
    answer(f, limited, 42901);
    // NOW = 17:00 +08:00, seven hours to local midnight. No host time involved.
    expect(String(limited.headers['retry-after'])).toBe('25200');
    expect(await idem(f, limitedKey)).toEqual([]);
    f.clock.advanceMs(2000);
    const again = await c.post(body, { key: limitedKey });
    answer(f, again, 42901);
    expect(String(again.headers['retry-after'])).toBe('25198');
    expect(await count(f, c.uid)).toBe('5');
    expect(await logs(f, c.uid)).toEqual([]);
  });
});

it('[AC-B1-11e#6] 成功同键在另一设备回放原响应；不同请求体冲突，新键 30402，关系日志始终一条', async () => {
  await http(async (f) => {
    const parent = await seed(f, CODE);
    await seed(f, OTHER_CODE);
    const c = await client(f);
    const otherDevice = await client(f, { uid: c.uid });
    const key = randomUUID();
    const original = answer(f, await c.post(undefined, { key }));
    const savedUser = await row(f, c.uid);
    const savedLogs = await logs(f, c.uid);
    f.clock.advanceMs(1000);
    const replies = await Promise.all([
      c.post(undefined, { key }),
      otherDevice.post(undefined, { key }),
    ]);
    for (const reply of replies) expect(answer(f, reply)).toEqual(original);
    expect(callsFor(f, c.uid)).toHaveLength(1);
    answer(f, await c.post({ invite_code: OTHER_CODE }, { key }), 20901);
    expect(callsFor(f, c.uid)).toHaveLength(1);
    answer(f, await c.post({ invite_code: OTHER_CODE }), 30402);
    expect(await row(f, c.uid)).toEqual(savedUser);
    expect(savedUser.parent_id).toBe(parent);
    expect(await logs(f, c.uid)).toEqual(savedLogs);
    expect(savedLogs).toHaveLength(1);
  });
});

it('[AC-B1-11e#7] 同用户不同键并发两次补填只有一个成功，另一个 30402，失败方不覆盖关系', async () => {
  await http(async (f) => {
    const parents = [await seed(f, CODE), await seed(f, OTHER_CODE)];
    const c = await client(f);
    const second = await client(f, { uid: c.uid });
    const results = await Promise.all([
      c.post({ invite_code: CODE }),
      second.post({ invite_code: OTHER_CODE }),
    ]);
    const codes = results.map((result) => result.json<{ code: number }>().code);
    expect([...codes].sort((a, b) => a - b)).toEqual([0, 30402]);
    for (const result of results) answer(f, result, result.json<{ code: number }>().code);
    const winningParent = parents[codes.indexOf(0)];
    expect(await row(f, c.uid)).toMatchObject({
      parent_id: winningParent,
      self_bind_used: true,
      parent_bind_source: 'backfill',
    });
    expect(await logs(f, c.uid)).toMatchObject([
      { to_parent_id: winningParent, source: 'backfill' },
    ]);
    expect(callsFor(f, c.uid)).toHaveLength(2);
  });
});

it('[AC-B1-11e#8] 核心已写关系与日志后抛错，两者回滚；同键恢复可成功，50001 不当成成功存储', async () => {
  await http(async (f) => {
    await seed(f, CODE);
    const c = await client(f);
    const before = await row(f, c.uid);
    const key = randomUUID();
    f.failAfterBind.add(c.uid);
    answer(f, await c.post(undefined, { key }), 50001);
    expect(f.boundBeforeFailure).toEqual([c.uid]);
    expect(callsFor(f, c.uid)[0]?.transactional).toBe(true);
    expect(await row(f, c.uid)).toEqual(before);
    expect(await logs(f, c.uid)).toEqual([]);
    expect(await idem(f, key)).toEqual([]);
    f.failAfterBind.delete(c.uid);
    answer(f, await c.post(undefined, { key }));
    expect(await logs(f, c.uid)).toHaveLength(1);
  });
});

for (const field of ['user_id', 'app_id', 'device_id', 'channel'] as const) {
  it(`[AC-B1-11e#9] 请求体不能注入 ${field}，校验拒绝后仅签名和令牌里的身份用于绑定`, async () => {
    await http(async (f) => {
      await seed(f, CODE);
      const foreignApp = `${f.appId}_other`;
      const victim = await seed(f, OTHER_CODE, { appId: foreignApp });
      const c = await client(f);
      const before = await row(f, victim, foreignApp);
      answer(
        f,
        await c.post({
          invite_code: CODE,
          [field]: field === 'app_id' ? foreignApp : field === 'channel' ? 'register' : victim,
        }),
        20001,
      );
      expect(callsFor(f, c.uid)).toEqual([]);
      expect(await logs(f, c.uid)).toEqual([]);
      expect(await row(f, victim, foreignApp)).toEqual(before);
      answer(f, await c.post());
      expect(callsFor(f, c.uid)).toMatchObject([
        {
          command: { app_id: c.appId, user_id: c.uid, device_id: c.deviceId, channel: 'backfill' },
        },
      ]);
      expect(await row(f, victim, foreignApp)).toEqual(before);
    });
  });
}

it('[AC-B1-11e#10] 本次签名设备并入同设备判定，即使本人尚无登录日志也返回 30403', async () => {
  await http(async (f) => {
    const parent = await seed(f, CODE);
    const c = await client(f);
    await f.db
      .insertInto('login_logs')
      .values({
        app_id: c.appId,
        user_id: parent,
        method: 'sms',
        ip: '192.0.2.44',
        device_id_hash: f.crypto.blindIndex(c.deviceId, 'login_logs.device_id'),
        created_at: new Date(NOW),
      })
      .execute();
    answer(f, await c.post(), 30403);
    expect(callsFor(f, c.uid)).toMatchObject([{ command: { device_id: c.deviceId } }]);
    expect(await logs(f, c.uid)).toEqual([]);
    expect(await row(f, c.uid)).toMatchObject({ parent_id: null, self_bind_used: false });
  });
});

for (const [label, headers, key, code] of [
  ['缺幂等键', {}, null, 20001],
  ['无令牌', {}, undefined, 10001],
  ['坏签名', { 'x-sign': '0'.repeat(64) }, undefined, 10401],
  ['跨 app 头', { 'x-app-id': 'other_app' }, undefined, 10403],
] as const) {
  it(`[AC-B1-11e#11] ${label} 由真实入口拒绝且不调用核心，修复请求后可绑定`, async () => {
    await http(async (f) => {
      await seed(f, CODE);
      const c = await client(f);
      answer(
        f,
        await c.post(undefined, {
          headers,
          omitAuthorization: label === '无令牌',
          ...(key === undefined ? {} : { key }),
        }),
        code,
      );
      expect(callsFor(f, c.uid)).toEqual([]);
      expect(await logs(f, c.uid)).toEqual([]);
      answer(f, await c.post());
      expect(callsFor(f, c.uid)).toHaveLength(1);
    });
  });
}

it('[AC-B1-11e#12] 同一邀请码在两个 app 各自解析为该 app 的邀请人，用户与日志不串 app', async () => {
  await http(async (f) => {
    const ownParent = await seed(f, CODE);
    const appId = 'couli_other';
    const otherParent = await seed(f, CODE, { appId });
    const a = await client(f);
    const b = await client(f, { appId });
    answer(f, await a.post());
    answer(f, await b.post());
    expect(await row(f, a.uid)).toMatchObject({ parent_id: ownParent });
    expect(await row(f, b.uid, appId)).toMatchObject({ parent_id: otherParent });
    expect(await logs(f, a.uid)).toMatchObject([{ app_id: a.appId, to_parent_id: ownParent }]);
    expect(await logs(f, b.uid, appId)).toMatchObject([
      { app_id: appId, to_parent_id: otherParent },
    ]);
  });
});

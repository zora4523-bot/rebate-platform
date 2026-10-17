import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { keys } from '../../risk/rate-limit/kit.ts';
import {
  openSuite,
  closeSuite,
  withFixture,
  failed,
  bound,
  order,
  child,
  riskState,
  loginLog,
  CODE,
  OTHER_CODE,
  OWN_CODE,
  DEVICE_CONTEXT,
  NOW,
  type Fixture,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

// Called after the first unavailable-inviter 30401, including for every parameterized case.
async function unavailableCounts(f: Fixture, deps: Parameters<Fixture['bind']>[1] = {}) {
  const stored = await keys(f.raw, `*${f.app}*`);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toContain(`${f.app}:2031-05-06:${(await f.row()).phone_hmac}`);
  expect(await f.raw.call('GET', stored[0]!)).toBe('1');
  // Mix a format failure with unavailable-inviter failures from both channels.
  for (const attempt of [
    { channel: 'register', invite_code: 'BAD', count: '2' },
    { channel: 'backfill', invite_code: CODE, count: '3' },
    { channel: 'register', invite_code: CODE, count: '4' },
    { channel: 'backfill', invite_code: CODE, count: '5' },
  ] as const) {
    await failed(f, 30401, { channel: attempt.channel, invite_code: attempt.invite_code }, deps);
    expect(await keys(f.raw, `*${f.app}*`)).toEqual(stored);
    expect(await f.raw.call('GET', stored[0]!)).toBe(attempt.count);
  }
  await seedUser(f.db, f.app, {
    invite: OTHER_CODE,
    phoneHmac: randomBytes(32).toString('hex'),
  });
  // A different, available inviter cannot bypass the shared daily quota.
  for (const channel of ['backfill', 'register'] as const) {
    expect(await failed(f, 42901, { channel, invite_code: OTHER_CODE })).toEqual({
      result: 'failed',
      code: 42901,
      retry_after_seconds: 25200,
    });
    expect(await f.raw.call('GET', stored[0]!)).toBe('5');
    expect(await keys(f.raw, `*${f.app}*`)).toEqual(stored);
  }
}

it('[AC-B1-11d#1] backfill 手机身份先于关闭开关与错误码格式', async () => {
  await withFixture(suite, async (f) => {
    await f.patch({ phone_hmac: null });
    f.values.set('growth.invite_bind.enabled', false);
    const configValue = vi.fn(f.deps.config.configValue);
    await failed(f, 10005, { invite_code: '' }, { config: { configValue } });
    expect(configValue).not.toHaveBeenCalled();
  });
});

it.each([false, 'off'])('[AC-B1-11d#2] 关闭开关 %s 先于 Redis、机会与格式', async (value) => {
  await withFixture(suite, async (f) => {
    f.values.set('growth.invite_bind.enabled', value);
    await f.patch({ self_bind_used: true });
    await f.deps.redis.close();
    await failed(f, 30408, { invite_code: '' });
  });
});

it.each([
  ['growth.invite_bind.enabled', 'invalid'],
  ['invite.fail_limit_per_day', 0],
  ['invite.fail_limit_per_day', 1.5],
  ['invite.fail_limit_per_day', 'five'],
  ['invite.backfill_hours', -1],
] as const)('[AC-B1-11d#3] 非法配置 %s=%s 失败且不消费机会', async (key, value) => {
  await withFixture(suite, async (f) => {
    f.values.set(key, value);
    await failed(f, 50001);
  });
});

it.each(['parent', 'used'])('[AC-B1-11d#4] %s 已占机会先于期限、活动和格式', async (kind) => {
  await withFixture(suite, async (f) => {
    await f.patch({
      ...(kind === 'parent' ? { parent_id: f.parentId } : { self_bind_used: true }),
      created_at: new Date('2031-01-01T00:00:00Z'),
    });
    await order(f);
    await failed(f, 30402, { invite_code: 'BAD' });
  });
});

it('[AC-B1-11d#5] 过期先于订单及空码', async () => {
  await withFixture(suite, async (f) => {
    await f.patch({ created_at: new Date('2031-04-29T09:00:00Z') });
    await order(f);
    await failed(f, 30404, { invite_code: '' });
  });
});

it.each(['VOID', 'ESTIMATED'])('[AC-B1-11d#6] 任意状态订单 %s 先于格式', async (status) => {
  await withFixture(suite, async (f) => {
    await order(f, status);
    await failed(f, 30409, { invite_code: '' });
  });
});

it.each(['normal', 'deleted'])('[AC-B1-11d#7] 任意状态直属下级 %s 阻止补填', async (status) => {
  await withFixture(suite, async (f) => {
    await child(f, f.userId, undefined, status);
    await failed(f, 30409, { invite_code: '' });
  });
});

it('[AC-B1-11d#8] 找回端口有记录即 30409，不要求申请表已上线', async () => {
  await withFixture(suite, async (f) => {
    const hasClaims = vi.fn(async () => true);
    await failed(
      f,
      30409,
      {},
      {
        activity: (trx) => ({ ...f.deps.activity(trx), hasClaims }),
      },
    );
    expect(hasClaims).toHaveBeenCalledWith({ appId: f.app, userId: f.userId });
  });
});

it('[AC-B1-11d#9] created_at +168h 前一秒可成功', async () => {
  await withFixture(suite, async (f) => {
    await f.patch({ created_at: new Date('2031-04-29T09:00:01Z') });
    await bound(f);
  });
});

it('[AC-B1-11d#10] created_at +168h 整点拒绝', async () => {
  await withFixture(suite, async (f) => {
    await f.patch({ created_at: new Date('2031-04-29T09:00:00Z') });
    await failed(f, 30404);
  });
});

it('[AC-B1-11d#11] 补填期限读取配置而非固定 168h', async () => {
  await withFixture(suite, async (f) => {
    f.values.set('invite.backfill_hours', 24);
    await failed(f, 30404);
  });
});

it.each(['ABCDE', 'K7O2MZ', 'K702MZ', 'K7I2MZ', 'K712MZ', '', '　\t　'])(
  '[AC-B1-11d#12] 规范化后非法码 %j 不查询邀请人并计入 30401',
  async (invite_code) => {
    await withFixture(suite, async (f) => {
      const readRisk = vi.fn(f.deps.readRisk);
      const start = f.queries.length;
      await failed(f, 30401, { invite_code }, { readRisk });
      expect(readRisk).not.toHaveBeenCalled();
      const lookups = f.queries
        .slice(start)
        .filter(
          (q) =>
            /\b(?:from|join)\s+(?:"?app"?\.)?"?users"?\b/i.test(q.sql) &&
            /\bwhere\b[\s\S]*\binvite_code\b/i.test(q.sql),
        );
      expect(lookups).toEqual([]);
      const stored = await keys(f.raw, `*${f.app}*`);
      expect(stored).toHaveLength(1);
      expect(await f.raw.call('GET', stored[0]!)).toBe('1');
    });
  },
);

it('[AC-B1-11d#13] 全角及小写输入规范化后匹配邀请人', async () => {
  await withFixture(suite, async (f) => {
    await bound(f, { invite_code: '　ｋ７ｑ２ｍｚ　' });
  });
});

it('[AC-B1-11d#14] 不存在的邀请码 30401', async () => {
  await withFixture(suite, async (f) => {
    await failed(f, 30401, { invite_code: OTHER_CODE });
  });
});

it.each(['banned', 'appealing', 'frozen'] as const)(
  '[AC-B1-11d#15] 风险状态 %s 邀请人不可用，即使同时同设备',
  async (state) => {
    await withFixture(suite, async (f) => {
      await riskState(f, state);
      await loginLog(
        f.db,
        f.app,
        f.parentId,
        suite.kit.crypto.blindIndex(f.command.device_id, DEVICE_CONTEXT),
      );
      await failed(f, 30401);
      await unavailableCounts(f);
    });
  },
);

it.each(['deleted', 'no_phone'])('[AC-B1-11d#16] 邀请人 %s 返回 30401', async (kind) => {
  await withFixture(suite, async (f) => {
    await f.patch(kind === 'deleted' ? { status: 'deleted' } : { phone_hmac: null }, f.parentId);
    await failed(f, 30401);
    await unavailableCounts(f);
  });
});

it('[AC-B1-11d#17] normal 且已绑手机邀请人成功；缺省实名端口不臆造生日', async () => {
  await withFixture(suite, async (f) => {
    await bound(f);
  });
});

it('[AC-B1-11d#52] 已实名邀请人距满 18 岁还差一天，30401 且不写数据库', async () => {
  await withFixture(suite, async (f) => {
    const verifiedBirthDate = vi.fn<NonNullable<typeof f.deps.verifiedBirthDate>>(
      async () => '2013-05-07',
    );
    await failed(f, 30401, {}, { verifiedBirthDate });
    expect(verifiedBirthDate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      app_id: f.app,
      user_id: f.parentId,
    });
    expect(verifiedBirthDate.mock.calls[0]![0].isTransaction).toBe(true);
    await unavailableCounts(f, { verifiedBirthDate });
  });
});

it.each(['2013-05-06', null])(
  '[AC-B1-11d#53] 实名生日 %j：当天满 18 岁或未实名均可绑定',
  async (birthday) => {
    await withFixture(suite, async (f) => {
      const before = await f.row();
      const verifiedBirthDate = vi.fn<NonNullable<typeof f.deps.verifiedBirthDate>>(
        async () => birthday,
      );
      expect(await f.bind({}, { verifiedBirthDate })).toEqual({
        result: 'bound',
        parent_id: f.parentId,
        bound_at: new Date(NOW),
      });
      expect(verifiedBirthDate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        app_id: f.app,
        user_id: f.parentId,
      });
      expect(verifiedBirthDate.mock.calls[0]![0].isTransaction).toBe(true);
      expect(await f.row()).toEqual({
        ...before,
        parent_id: f.parentId,
        parent_bind_source: 'backfill',
        parent_bound_at: new Date(NOW),
        self_bind_used: true,
        updated_at: new Date(NOW),
        row_version: before.row_version + 1,
      });
      expect(await f.logs()).toEqual([
        {
          app_id: f.app,
          user_id: f.userId,
          from_parent_id: null,
          to_parent_id: f.parentId,
          source: 'backfill',
          operator: `user:${f.userId}`,
          reason: null,
          at: new Date(NOW),
        },
      ]);
    });
  },
);

it('[AC-B1-11d#18] 自己的邀请码 30403', async () => {
  await withFixture(suite, async (f) => {
    await failed(f, 30403, { invite_code: OWN_CODE });
  });
});

it.each([1, 3])('[AC-B1-11d#19] register 第 %i 层下级的邀请码构成环', async (depth) => {
  await withFixture(suite, async (f) => {
    let parent = f.userId;
    for (let i = 0; i < depth; i++)
      parent = await child(f, parent, i === depth - 1 ? OTHER_CODE : undefined);
    // Backfill would correctly stop at 30409 first; register reaches the cycle check.
    await failed(f, 30403, { channel: 'register', invite_code: OTHER_CODE });
  });
});

it('[AC-B1-11d#20] 两人历史登录设备相交，旧记录仍参与且不是 device_hash', async () => {
  await withFixture(suite, async (f) => {
    const common = randomBytes(32).toString('hex');
    await loginLog(f.db, f.app, f.userId, common);
    await loginLog(f.db, f.app, f.parentId, common);
    await failed(f, 30403);
  });
});

it('[AC-B1-11d#21] backfill 把本次签名设备并入集合，即使本人尚无登录日志', async () => {
  await withFixture(suite, async (f) => {
    await loginLog(
      f.db,
      f.app,
      f.parentId,
      suite.kit.crypto.blindIndex(f.command.device_id, DEVICE_CONTEXT),
    );
    await failed(f, 30403);
  });
});

it('[AC-B1-11d#22] 相同 device_hash 但不同 device_id_hash 不冲突', async () => {
  await withFixture(suite, async (f) => {
    for (const uid of [f.userId, f.parentId]) {
      await f.db
        .withSchema('app')
        .insertInto('login_logs')
        .values({
          app_id: f.app,
          user_id: uid,
          device_id_hash: randomBytes(32).toString('hex'),
          device_hash: 'a'.repeat(64),
          ip: '192.0.2.45',
          method: 'sms',
          created_at: new Date('2031-05-06T08:00:00Z'),
        })
        .execute();
    }
    await bound(f);
  });
});

it('[AC-B1-11d#23] 第五次 30401 后正确码仍 42901，+08 日界恢复、TTL 首次设置', async () => {
  await withFixture(suite, async (f) => {
    for (const code of ['', 'BAD', 'K7O2MZ', OTHER_CODE, 'K712MZ']) {
      await failed(f, 30401, { invite_code: code });
    }
    expect(await failed(f, 42901)).toEqual({
      result: 'failed',
      code: 42901,
      retry_after_seconds: 25200,
    });
    const stored = await keys(f.raw, `*${f.app}*`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain(`${f.app}:2031-05-06:${(await f.row()).phone_hmac}`);
    expect(await f.raw.call('GET', stored[0]!)).toBe('5');
    expect(Number(await f.raw.call('TTL', stored[0]!))).toBeGreaterThanOrEqual(25250);
    expect(Number(await f.raw.call('TTL', stored[0]!))).toBeLessThanOrEqual(25260);
    f.clock.set('2031-05-06T16:00:00.000Z');
    await bound(f);
  });
});

it('[AC-B1-11d#24] 频控先于已有上级；开关先于频控', async () => {
  await withFixture(suite, async (f) => {
    for (let i = 0; i < 5; i++) await failed(f, 30401, { invite_code: '' });
    await f.patch({ parent_id: f.parentId });
    await failed(f, 42901, { invite_code: '' });
    f.values.set('growth.invite_bind.enabled', 'off');
    await failed(f, 30408);
  });
});

it('[AC-B1-11d#25] 30403 不计数，失败不消费机会，之后可正常绑定', async () => {
  await withFixture(suite, async (f) => {
    for (let i = 0; i < 6; i++) await failed(f, 30403, { invite_code: OWN_CODE });
    expect(await keys(f.raw, `*${f.app}*`)).toEqual([]);
    await bound(f);
  });
});

it('[AC-B1-11d#26] 频控使用配置值，午夜前不足一秒 Retry-After 向上取整为一秒', async () => {
  await withFixture(suite, async (f) => {
    f.values.set('invite.fail_limit_per_day', 1);
    f.clock.set('2031-05-06T15:59:59.500Z');
    await failed(f, 30401, { invite_code: '' });
    expect(await failed(f, 42901)).toEqual({
      result: 'failed',
      code: 42901,
      retry_after_seconds: 1,
    });
  });
});

it('[AC-B1-11d#27] 计数按 phone_hmac 隔离，不按设备或 user_id', async () => {
  await withFixture(suite, async (f) => {
    for (let i = 0; i < 5; i++) await failed(f, 30401, { invite_code: '' });
    await f.patch({ phone_hmac: randomBytes(32).toString('hex') });
    await bound(f, { device_id: f.command.device_id });
  });
});

it('[AC-B1-11d#28] Redis 读不可用返回 50001，数据库不写', async () => {
  await withFixture(suite, async (f) => {
    await f.deps.redis.close();
    await failed(f, 50001);
  });
});

it('[AC-B1-11d#29] Redis 读取成功但 30401 计数写失败也返回 50001', async () => {
  await withFixture(suite, async (f) => {
    const redis = f.deps.redis;
    const evalCall = vi.fn(async () => {
      throw new Error('fixture write outage');
    });
    const failing = {
      ...redis,
      namespace(name: string) {
        const ns = redis.namespace(name);
        return {
          ...ns,
          set: async () => {
            throw new Error('fixture write outage');
          },
          eval: evalCall,
        };
      },
    };
    await failed(f, 50001, { invite_code: '' }, { redis: failing });
    expect(await keys(f.raw, `*${f.app}*`)).toEqual([]);
  });
});

it('[AC-B1-11d#30] 邀请码只能匹配同 app，外 app 相同设备记录不冲突', async () => {
  await withFixture(suite, async (f) => {
    const otherApp = `foreign_${randomUUID()}`;
    const foreign = await seedUser(f.db, otherApp, {
      invite: OTHER_CODE,
      phoneHmac: 'foreign-phone',
    });
    await failed(f, 30401, { invite_code: OTHER_CODE });
    const hash = suite.kit.crypto.blindIndex(f.command.device_id, DEVICE_CONTEXT);
    await loginLog(f.db, otherApp, foreign, hash);
    await bound(f);
  });
});

it('[AC-B1-11d#49] 30401 累加不重设已有键 TTL', async () => {
  await withFixture(suite, async (f) => {
    await failed(f, 30401, { invite_code: '' });
    const stored = await keys(f.raw, `*${f.app}*`);
    expect(stored).toHaveLength(1);
    await f.raw.call('EXPIRE', stored[0]!, 120);
    await failed(f, 30401, { invite_code: '' });
    expect(await f.raw.call('GET', stored[0]!)).toBe('2');
    expect(Number(await f.raw.call('TTL', stored[0]!))).toBeGreaterThan(0);
    expect(Number(await f.raw.call('TTL', stored[0]!))).toBeLessThanOrEqual(120);
  });
});

it('[AC-B1-11d#50] 同 phone_hmac 在另一个 app 不继承频控', async () => {
  await withFixture(suite, async (f) => {
    for (let i = 0; i < 5; i++) await failed(f, 30401, { invite_code: '' });
    const app = `other_${randomUUID()}`;
    const user = await seedUser(f.db, app, { phoneHmac: (await f.row()).phone_hmac! });
    const parent = await seedUser(f.db, app, { invite: CODE, phoneHmac: 'fixture-other-parent' });
    await f.db
      .withSchema('app')
      .updateTable('users')
      .set({ created_at: f.clock.now() })
      .where('app_id', '=', app)
      .execute();
    expect(await f.bind({ app_id: app, user_id: user })).toEqual({
      result: 'bound',
      parent_id: parent,
      bound_at: f.clock.now(),
    });
    expect((await f.row()).parent_id).toBeNull();
    expect(await f.logs()).toEqual([]);
  });
});

it('[AC-B1-11d#51] 并发五次 30401 不丢计数，第六次仍限流', async () => {
  await withFixture(suite, async (f) => {
    const binder = await f.binder();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.db.transaction().execute((trx) => binder.bind(trx, { ...f.command, invite_code: '' })),
      ),
    );
    expect(answers).toEqual([
      { result: 'failed', code: 30401 },
      { result: 'failed', code: 30401 },
      { result: 'failed', code: 30401 },
      { result: 'failed', code: 30401 },
      { result: 'failed', code: 30401 },
    ]);
    expect(await failed(f, 42901)).toEqual({
      result: 'failed',
      code: 42901,
      retry_after_seconds: 25200,
    });
  });
});

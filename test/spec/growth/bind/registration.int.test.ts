import { randomBytes } from 'node:crypto';
import { PostgresQueryCompiler } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { validate } from '../../identity/sms-login/http-kit.ts';
import { phone } from '../../risk/sms-risk/kit.ts';
import { keys } from '../../risk/rate-limit/kit.ts';
import { withHttp, type HttpFixture } from '../../risk/sms-risk/http-kit.ts';
import {
  openSuite,
  closeSuite,
  withFixture,
  growth,
  row,
  logs,
  loginLog,
  identity,
  CODE,
  NOW,
  DEVICE_CONTEXT,
  type Suite,
} from './kit.ts';

let suite: Suite;
type RegistrationPort = NonNullable<
  import('../../../../apps/api/src/modules/identity/application/registration.ts').RegistrationOptions['bindInvite']
>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

async function prepared(f: HttpFixture, number = phone()) {
  const client = await f.client();
  const sent = await client.send(number);
  expect(sent.statusCode).toBe(200);
  expect(sent.json()).toMatchObject({ code: 0 });
  const code = f.sender.outbox().findLast((message) => message.phone === number)?.code;
  expect(code).toMatch(/^\d{6}$/);
  return {
    client,
    number,
    login: (invite_code = CODE) =>
      client.post('/v1/auth/login/sms', {
        phone: number,
        code,
        invite_code,
        legal_versions: { privacy: 1, agreement: 1 },
        consent_at: f.clock.now().toISOString(),
      }),
  };
}
async function inviter(f: HttpFixture) {
  return seedUser(suite.kit.db, f.id, {
    invite: CODE,
    phoneHmac: randomBytes(32).toString('hex'),
  });
}
async function answer(
  response: Awaited<ReturnType<Awaited<ReturnType<typeof prepared>>['login']>>,
  bind: { result: 'bound'; code: null } | { result: 'failed'; code: number },
) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: { is_new_user: true, invite_bind: bind },
  });
  await validate(response, true);
  return response.json<{ data: { user_id: string } }>().data.user_id;
}
async function unbound(f: HttpFixture, uid: string) {
  expect(await row(suite.kit.db, f.id, uid)).toMatchObject({
    parent_id: null,
    parent_bind_source: null,
    parent_bound_at: null,
    self_bind_used: false,
  });
  expect(await logs(suite.kit.db, f.id, uid)).toEqual([]);
}

it.each([false, 'off'])(
  '[AC-B1-11d#40] 真短信新号：开关 %s 时建号成功但绑定 30408',
  async (value) => {
    await withHttp(suite, { 'growth.invite_bind.enabled': value }, async (f) => {
      await inviter(f);
      const p = await prepared(f);
      const uid = await answer(await p.login(), { result: 'failed', code: 30408 });
      await unbound(f, uid);
    });
  },
);

it('[AC-B1-11d#41] 真短信新号：签名设备命中邀请人历史设备，绑定 30403 而账号保留', async () => {
  await withHttp(suite, {}, async (f) => {
    const parent = await inviter(f);
    const p = await prepared(f);
    await loginLog(
      suite.kit.db,
      f.id,
      parent,
      f.crypto.blindIndex(p.client.deviceId, DEVICE_CONTEXT),
    );
    const uid = await answer(await p.login(), { result: 'failed', code: 30403 });
    await unbound(f, uid);
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('login_logs')
        .select('device_id_hash')
        .where('app_id', '=', f.id)
        .where('user_id', '=', uid)
        .execute(),
    ).toEqual([{ device_id_hash: f.crypto.blindIndex(p.client.deviceId, DEVICE_CONTEXT) }]);
  });
});

it('[AC-B1-11d#42] 真短信新号：正常邀请绑定与注册审计同事务', async () => {
  await withHttp(suite, {}, async (f) => {
    const parent = await inviter(f);
    const p = await prepared(f);
    const uid = await answer(await p.login('　ｋ７ｑ２ｍｚ　'), { result: 'bound', code: null });
    expect(await row(suite.kit.db, f.id, uid)).toMatchObject({
      parent_id: parent,
      parent_bind_source: 'register',
      parent_bound_at: new Date(NOW),
      self_bind_used: true,
    });
    expect(await logs(suite.kit.db, f.id, uid)).toEqual([
      {
        app_id: f.id,
        user_id: uid,
        from_parent_id: null,
        to_parent_id: parent,
        source: 'register',
        operator: `user:${uid}`,
        reason: null,
        at: new Date(NOW),
      },
    ]);
  });
});

it('[AC-B1-11d#43] 真短信新号：格式错误 30401 由 growth 处理且不消费机会', async () => {
  await withHttp(suite, {}, async (f) => {
    await inviter(f);
    const p = await prepared(f);
    const uid = await answer(await p.login('ABCDE'), { result: 'failed', code: 30401 });
    await unbound(f, uid);
    const before = await row(suite.kit.db, f.id, uid);
    const id = await identity();
    const phoneHmac = f.crypto.blindIndex(p.number, id.PHONE_BLIND_INDEX_CONTEXT);
    expect(before.phone_hmac).toBe(phoneHmac);
    await withFixture(suite, async (base) => {
      const stored = await keys(base.raw, `*${f.id}:2031-05-06:${phoneHmac}`);
      expect(stored).toHaveLength(1);
      expect(await base.raw.call('GET', stored[0]!)).toBe('1');
      try {
        const binder = await base.binder({ clock: f.clock, crypto: f.crypto });
        const bind = (invite_code: string) =>
          suite.kit.db.transaction().execute((trx) =>
            binder.bind(trx, {
              channel: 'backfill',
              app_id: f.id,
              user_id: uid,
              invite_code,
              device_id: p.client.deviceId,
            }),
          );
        // Registration's SAVEPOINT rollback must not undo its Redis failure count.
        for (const count of ['2', '3', '4', '5']) {
          expect(await bind('BAD')).toEqual({ result: 'failed', code: 30401 });
          expect(await base.raw.call('GET', stored[0]!)).toBe(count);
        }
        expect(await bind(CODE)).toEqual({
          result: 'failed',
          code: 42901,
          retry_after_seconds: 25200,
        });
        expect(await base.raw.call('GET', stored[0]!)).toBe('5');
        expect(await row(suite.kit.db, f.id, uid)).toEqual(before);
        await unbound(f, uid);
      } finally {
        await base.raw.call('DEL', ...stored);
      }
    });
  });
});

it('[AC-B1-11d#44] backfill 的五次 30401 与 register 共用 phone_hmac 当日计数', async () => {
  await withHttp(suite, {}, async (f) => {
    await inviter(f);
    const p = await prepared(f);
    const id = await identity();
    const holder = await seedUser(suite.kit.db, f.id, {
      phoneHmac: f.crypto.blindIndex(p.number, id.PHONE_BLIND_INDEX_CONTEXT),
    });
    await suite.kit.db
      .withSchema('app')
      .updateTable('users')
      .set({ created_at: f.clock.now() })
      .where('id', '=', holder)
      .execute();
    await withFixture(suite, async (base) => {
      const binder = await base.binder({ clock: f.clock, crypto: f.crypto });
      for (let i = 0; i < 5; i++) {
        expect(
          await suite.kit.db.transaction().execute((trx) =>
            binder.bind(trx, {
              channel: 'backfill',
              app_id: f.id,
              user_id: holder,
              invite_code: 'BAD',
              device_id: p.client.deviceId,
            }),
          ),
        ).toEqual({ result: 'failed', code: 30401 });
      }
    });
    // A deleted historical account releases the phone unique key, but never the Redis quota.
    await suite.kit.db
      .withSchema('app')
      .updateTable('users')
      .set({ status: 'deleted' })
      .where('id', '=', holder)
      .execute();
    const uid = await answer(await p.login(), { result: 'failed', code: 42901 });
    expect(uid).not.toBe(holder);
    await unbound(f, uid);
  });
});

it('[AC-B1-11d#45] 真短信新号：只有绑定 Redis 故障时回 50001，账号及登录保留', async () => {
  const module = await growth();
  const create = module.createInviteBinder;
  let broken = false;
  const factory = vi.spyOn(module, 'createInviteBinder').mockImplementation((deps) =>
    create({
      ...deps,
      redis: {
        ...deps.redis,
        namespace(name) {
          const ns = deps.redis.namespace(name);
          return {
            async get(key) {
              if (broken) throw new Error('fixture Redis outage');
              return ns.get(key);
            },
            async set(key, value, ttl) {
              if (broken) throw new Error('fixture Redis outage');
              return ns.set(key, value, ttl);
            },
            async eval(script, options) {
              if (broken) throw new Error('fixture Redis outage');
              return ns.eval(script, options);
            },
          };
        },
      },
    }),
  );
  try {
    await withHttp(suite, {}, async (f) => {
      expect(factory).toHaveBeenCalled();
      await inviter(f);
      // A real successful bind proves 50001 below is not the old missing-port fallback.
      await answer(await (await prepared(f)).login(), { result: 'bound', code: null });
      broken = true;
      const uid = await answer(await (await prepared(f)).login(), {
        result: 'failed',
        code: 50001,
      });
      await unbound(f, uid);
      expect(
        await suite.kit.db
          .withSchema('app')
          .selectFrom('sessions')
          .select('sid')
          .where('app_id', '=', f.id)
          .where('user_id', '=', uid)
          .execute(),
      ).toHaveLength(1);
    });
  } finally {
    factory.mockRestore();
  }
});

it('[AC-B1-11d#46] 真实注册 SAVEPOINT：关系日志故障回滚绑定，不回滚已建账号', async () => {
  let broken = false;
  const hit = vi.fn();
  const db = suite.kit.db.withPlugin({
    transformQuery({ node, queryId }) {
      const statement = new PostgresQueryCompiler().compileQuery(node, queryId).sql;
      if (broken && /insert\s+into\s+(?:"?app"?\.)?"?relation_change_logs\b/i.test(statement)) {
        hit();
        throw new Error('fixture audit unavailable');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  await withHttp({ ...suite, kit: { ...suite.kit, db } }, {}, async (f) => {
    await inviter(f);
    await answer(await (await prepared(f)).login(), { result: 'bound', code: null });
    broken = true;
    const uid = await answer(await (await prepared(f)).login(), { result: 'failed', code: 50001 });
    expect(hit).toHaveBeenCalledTimes(1);
    await unbound(f, uid);
  });
});

it.each([
  { code: 30401, expected: 30401 },
  { code: 30403, expected: 30403 },
  { code: 30408, expected: 30408 },
  { code: 42901, expected: 42901 },
  { code: 10005, expected: 50001 },
  { code: 30402, expected: 50001 },
  { code: 30404, expected: 50001 },
  { code: 30409, expected: 50001 },
  { code: 50001, expected: 50001 },
] as const)(
  '[AC-B1-11d#47] register 适配器映射错误码 $code 为 $expected 并透传原事务及服务端设备',
  async ({ code, expected }) => {
    await withFixture(suite, async (f) => {
      const bind = vi.fn(async () => ({ result: 'failed' as const, code }));
      const adapter: RegistrationPort = (await growth()).createRegistrationInviteBinding({ bind });
      await f.db.transaction().execute(async (trx) => {
        expect(
          await adapter(trx, {
            app_id: f.app,
            user_id: f.userId,
            invite_code: CODE,
            device_id: f.command.device_id,
            phone: '13900000001',
            register_method: 'sms',
            client_ip: '192.0.2.44',
          }),
        ).toEqual({
          result: 'failed',
          code: expected,
        });
        expect(bind).toHaveBeenCalledExactlyOnceWith(trx, {
          channel: 'register',
          app_id: f.app,
          user_id: f.userId,
          invite_code: CODE,
          device_id: f.command.device_id,
        });
      });
    });
  },
);

it('[AC-B1-11d#48] register 适配器将成功映射成契约 bound/code:null', async () => {
  await withFixture(suite, async (f) => {
    const bind = vi.fn(async () => ({
      result: 'bound' as const,
      parent_id: f.parentId,
      bound_at: new Date(NOW),
    }));
    const adapter: RegistrationPort = (await growth()).createRegistrationInviteBinding({ bind });
    await f.db.transaction().execute(async (trx) => {
      expect(
        await adapter(trx, {
          app_id: f.app,
          user_id: f.userId,
          invite_code: CODE,
          device_id: f.command.device_id,
          phone: '13900000001',
          register_method: 'sms',
          client_ip: '192.0.2.44',
        }),
      ).toEqual({ result: 'bound', code: null });
    });
  });
});

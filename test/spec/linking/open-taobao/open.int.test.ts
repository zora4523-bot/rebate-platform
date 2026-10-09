import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { expectOpaqueState } from '../auth-url/kit.ts';
import {
  ACTIVE_PID,
  PROMO,
  codeJump,
  compose,
  failure,
  noAuthState,
  setup,
  success,
  urlJump,
  type Binding,
  type Fixture,
} from './kit.ts';

// Task B1-06f, including the orchestrator's 2026-10-08 decisions, is the rule source.
// Only this new composition boundary is exercised; frozen requote tests remain untouched.
const database = databaseFixture(createTestDatabase);
const unauthorized = [
  ['absent', 30101],
  ['unbound', 30101],
  ['pending_auth', 30101],
  ['released', 30101],
  ['invalid', 30102],
] as const;

async function expireAccount(f: Fixture) {
  await f.db
    .updateTable('union_accounts')
    .set({ auth_status: 'expired' })
    .where('id', '=', f.account)
    .execute();
  // An unrelated valid account must not mask the account selected by the binding / active pid.
  await f.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      platform: 'taobao',
      account_name: 'synthetic-other-active',
      status: 'active',
      auth_status: 'active',
      created_at: f.f.clock.now(),
      updated_at: f.f.clock.now(),
    })
    .execute();
}

async function issuedState(
  result: Awaited<ReturnType<ReturnType<typeof compose>>>,
  f: Fixture,
  code: number,
  userId = f.a,
  linkId = f.row.link_id,
  client = 'ios',
  methods = ['web_code'],
) {
  await failure(result, f, code);
  expect(result.envelope.data).toMatchObject({
    auth_url: expect.any(String),
    state: expect.any(String),
    auth_methods: methods,
  });
  const data = result.envelope.data as { auth_url: string; state: string; auth_methods: string[] };
  const url = new URL(data.auth_url);
  expect(url.protocol).toBe('https:');
  expect(url.searchParams.get('state')).toBe(data.state);
  expectOpaqueState(data.state, userId, f.device);
  expect(await f.sessions()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: userId,
      device_id: f.device,
      platform: 'taobao',
      mode: 'bind',
      link_id: linkId,
      client,
      auth_methods: methods,
      auth_app_refs: Object.fromEntries(
        methods.map((method) => [method, `synthetic/test/${client}/${method}`]),
      ),
      expire_at: new Date(f.f.clock.now().getTime() + 600_000),
      used_at: null,
      created_at: f.f.clock.now(),
    }),
  ]);
  expect(JSON.stringify(await f.sessions())).not.toContain(f.canary);
  expect(f.f.fetch).not.toHaveBeenCalled();
  expect(await f.logs()).toEqual([expect.objectContaining({ result_code: code, link_id: linkId })]);
}

it.each(['ios', 'android', 'harmony'] as const)(
  '[AC-B1-06f#1] %s active 无推广链接：原始 item_id、当前场景推广位和快照用户 relation_id',
  async (client) => {
    const f = await setup(database());
    await f.bind('active');
    const open = compose(f);
    const data = codeJump(await open(f.request({ client, installed: 'false' })), f);
    expect(f.row.pid).not.toBe(ACTIVE_PID.self_buy);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: f.appId,
      platform: 'taobao',
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    expect(f.f.fetch).toHaveBeenCalledTimes(1);
    expect(await f.logs()).toEqual([
      expect.objectContaining({ result_code: 0, user_id: f.a, no_rebate: false }),
    ]);
    expect(await f.attempts()).toEqual([
      expect.objectContaining({ attempt_id: data.attempt_id, user_id: f.a }),
    ]);
    expect(await f.sessions()).toEqual([]);
  },
);

it('[AC-B1-06f#2] 可用我方推广链接只下发 openByUrl，installed=false 也保持合法 SDK 步骤', async () => {
  const f = await setup(database());
  await f.bind('active');
  await f.promo();
  urlJump(await compose(f)(f.request({ installed: 'false' })));
});

it.each([
  'expired',
  'boundary',
  'missing_timestamp',
  'missing_url',
  'http',
  'malformed',
  'too_long',
] as const)('[AC-B1-06f#3] 我方推广链接 %s 不可用时回到 openByCode，不泄露旧链接', async (kind) => {
  const f = await setup(database());
  await f.bind('active');
  const url =
    kind === 'missing_url'
      ? null
      : kind === 'http'
        ? 'http://promo.example.test/synthetic'
        : kind === 'malformed'
          ? 'not-a-uri'
          : kind === 'too_long'
            ? `https://promo.example.test/${'x'.repeat(2048)}`
            : PROMO;
  await f.promo(url, kind === 'missing_timestamp' ? null : f.f.clock.now());
  if (kind === 'expired' || kind === 'boundary') {
    // W_link is links.expire_at, not an invented age limit on promo_url_fetched_at.
    f.f.clock.set(new Date(f.row.expire_at).toISOString());
    if (kind === 'expired') f.f.clock.advanceMs(1);
  }
  const result = await compose(f)();
  codeJump(result, f);
  expect(JSON.stringify(result)).not.toContain('promo.example.test');
});

it('[AC-B1-06f#4] 只读快照用户本 app 的 active 绑定，忽略本人 released、同 app 他人和其他 app 绑定', async () => {
  const f = await setup(database());
  await f.bind('released', f.a, 'rel-old');
  await f.bind('active');
  await f.bind('active', f.b);
  const foreign = await setup(database());
  // users.id is globally unique and bindings have a composite user FK: the same uid cannot
  // legally be seeded in a second app. Exercise a real foreign-app binding instead.
  await foreign.bind('active', foreign.a, 'rel-foreign');
  const result = await compose(f)();
  codeJump(result, f);
  for (const relation of ['rel-old', 'rel-B', 'rel-foreign'])
    expect(JSON.stringify(result)).not.toContain(relation);
});

it('[AC-B1-06f#5] B 开 A 非分享链接重新登记 B 身份，不复制 A 的推广链接', async () => {
  const f = await setup(database());
  await f.bind('active');
  await f.bind('active', f.b);
  await f.promo();
  f.opener(f.b);
  const result = await compose(f)();
  const data = codeJump(result, f, 'self_buy', 'rel-B');
  expect(data.new_link_id).toEqual(expect.any(String));
  expect(data.new_link_id).not.toBe(f.row.link_id);
  expect(JSON.stringify(result)).not.toContain(PROMO);
  expect((await f.links()).find((row) => row.link_id === data.new_link_id)).toMatchObject({
    user_id: f.b,
    scene: 'detail',
    pid_scene: 'self_buy',
    promo_url: null,
    promo_url_fetched_at: null,
  });
});

it('[AC-B1-06f#6] B 未绑定开 A 非分享链接：state 绑定新登记的 B link，重放不再登记', async () => {
  const f = await setup(database());
  await f.bind('active');
  await f.promo();
  f.opener(f.b);
  const open = compose(f);
  const request = f.request();
  const result = await open(request);
  const rows = await f.links();
  const fresh = rows.find((row) => row.link_id !== f.row.link_id);
  expect(rows).toHaveLength(2);
  expect(fresh).toMatchObject({
    user_id: f.b,
    scene: 'detail',
    promo_url: null,
    promo_url_fetched_at: null,
  });
  await issuedState(result, f, 30101, f.b, fresh!.link_id);
  expect(await open(request)).toEqual(result);
  expect(await f.links()).toEqual(rows);
  expect(await f.sessions()).toHaveLength(1);
  expect(await f.logs()).toHaveLength(1);
});

it.each(['member', 'guest'] as const)(
  '[AC-B1-06f#7] %s 开 A 分享链接保留分享者关系与 share 推广位，忽略 no_rebate',
  async (opener) => {
    const f = await setup(database(), 'share');
    await f.bind('active');
    await f.bind('blocked', f.b);
    f.opener(opener === 'guest' ? null : f.b);
    const open = compose(f);
    const first = codeJump(await open(f.request({ noRebate: true })), f, 'share');
    expect(first.new_link_id).toBeNull();
    expect(await f.logs()).toEqual([
      expect.objectContaining({
        user_id: f.a,
        opener_user_id: opener === 'guest' ? null : f.b,
        no_rebate: false,
        no_rebate_reason: null,
      }),
    ]);
    // A fresh instance/cache is not required: a later valid promo may be used after TTL.
    await f.promo();
    f.f.cache.entries.clear();
    f.f.clock.advanceMs(3001);
    urlJump(await open(f.request({ noRebate: true })));
    expect(await f.links()).toHaveLength(1);
  },
);

it('[AC-B1-06f#8] A 开自己分享链接登记 self_buy，用自己的绑定但不用 share promo', async () => {
  const f = await setup(database(), 'share');
  await f.bind('active');
  await f.promo();
  const result = await compose(f)();
  const data = codeJump(result, f);
  expect(data.new_link_id).toEqual(expect.any(String));
  expect((await f.links()).find((row) => row.link_id === data.new_link_id)).toMatchObject({
    user_id: f.a,
    pid_scene: 'self_buy',
    promo_url: null,
  });
  expect(JSON.stringify(result)).not.toContain(PROMO);
});

it.each(['guest', 'missing', 'foreign_app'] as const)(
  '[AC-B1-06f#9] 归属失败 %s 优先于关闭开关，不签发 state、不取价',
  async (kind) => {
    const f = await setup(database());
    f.f.config.set('convert.enabled.taobao', false);
    if (kind === 'guest') f.opener(null);
    if (kind === 'foreign_app')
      f.f.current.mockResolvedValue({
        appId: 'synthetic_foreign',
        userId: f.a,
        deviceId: f.device,
      });
    const result = await compose(f)(
      f.request({ linkId: kind === 'missing' ? randomUUID() : f.row.link_id }),
    );
    await failure(result, f, kind === 'guest' ? 10001 : 30144, kind === 'guest' ? 401 : 404);
    await noAuthState(result, f);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it.each(unauthorized)(
  '[AC-B1-06f#10] 本人绑定 %s 返回 %i，签发 10 分钟一次性 state、日志且幂等重放',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    const open = compose(f);
    const request = f.request();
    const result = await open(request);
    await issuedState(result, f, code);
    const before = await f.sessions();
    expect(await open(request)).toEqual(result);
    expect(await f.sessions()).toEqual(before);
    expect(await f.logs()).toHaveLength(1);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ['android', 'ios', ['sdk_token', 'web_code']],
  ['harmony', 'android', ['web_code', 'sdk_token']],
] as const)(
  '[AC-B1-06f#11] 设备记录 %s 与声明 %s 不同，按设备端配置持久化授权方式与应用引用',
  async (client, reported, methods) => {
    const f = await setup(database());
    await f.db
      .updateTable('devices')
      .set({ platform: client })
      .where('id', '=', f.device)
      .execute();
    await f.db
      .insertInto('config_items')
      .values({
        app_id: f.appId,
        key: `union.taobao.auth_methods.${client}`,
        value: JSON.stringify(methods),
        updated_by: 'synthetic-fixture',
      })
      .execute();
    const result = await compose(f)(f.request({ client: reported }));
    await issuedState(result, f, 30101, f.a, f.row.link_id, client, [...methods]);
    for (const method of methods)
      expect(f.resolve).toHaveBeenCalledWith(f.appId, 'test', client, method);
  },
);

it('[AC-B1-06f#12] blocked 用户未封禁返回 30153，无授权入口、state、外跳与取价', async () => {
  const f = await setup(database());
  await f.bind('blocked');
  const result = await compose(f)();
  await failure(result, f, 30153);
  await noAuthState(result, f);
  expect(f.f.fetch).not.toHaveBeenCalled();
  expect(await f.logs()).toEqual([expect.objectContaining({ result_code: 30153 })]);
});

it.each(
  unauthorized.flatMap(([status, code]) =>
    [false, true].map((noRebate) => ({ status, code, noRebate })),
  ),
)(
  '[AC-B1-06f#13] 本次站长账号 expired，$status / no_rebate=$noRebate 仍返回 $code auth_unavailable',
  async ({ status, code, noRebate }) => {
    const f = await setup(database());
    await f.bind(status);
    await expireAccount(f);
    const result = await compose(f)(f.request({ noRebate }));
    await failure(result, f, code);
    expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
    await noAuthState(result, f);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ['active', false],
  ['blocked', false],
  ['blocked', true],
] as const)(
  '[AC-B1-06f#14] expired 账号下 %s / no_rebate=%s 保持 active 放行和 blocked 例外',
  async (status, noRebate) => {
    const f = await setup(database());
    await f.bind(status);
    await expireAccount(f);
    const result = await compose(f)(f.request({ noRebate }));
    if (status === 'blocked' && !noRebate) await failure(result, f, 30153);
    else codeJump(result, f, 'self_buy', noRebate ? null : 'rel-A');
    await noAuthState(result, f);
  },
);

const shareFailures = (
  ['absent', 'unbound', 'pending_auth', 'invalid', 'released', 'blocked', 'expired'] as const
).flatMap((status) => ['member', 'guest'].map((opener) => ({ status, opener })));
it.each(shareFailures)(
  '[AC-B1-06f#15] $opener 开分享者 $status 链接统一 30102，不泄露分享者状态且忽略 no_rebate',
  async ({ status, opener }) => {
    const f = await setup(database(), 'share');
    await f.bind(status === 'expired' ? 'unbound' : status);
    if (status === 'expired') await expireAccount(f);
    await f.bind('active', f.b);
    f.opener(opener === 'guest' ? null : f.b);
    const result = await compose(f)(f.request({ noRebate: true }));
    await failure(result, f, 30102);
    await noAuthState(result, f);
    expect(f.f.fetch).not.toHaveBeenCalled();
    expect(await f.links()).toHaveLength(1);
  },
);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released', 'blocked', 'active'] as const)(
  '[AC-B1-06f#16] 站长正常 %s 无返利购买使用 self_buy，不带用户参数、不用旧 promo',
  async (status) => {
    const f = await setup(database(), 'share');
    await f.bind(status);
    await f.promo();
    const before = await f.links();
    const result = await compose(f)(f.request({ noRebate: true, noRebateReason: 'auth_failed' }));
    codeJump(result, f, 'self_buy', null);
    for (const value of [PROMO, 'rel-A', 'demo0001', f.a, f.b])
      expect(JSON.stringify(result)).not.toContain(value);
    expect(await f.logs()).toEqual([
      expect.objectContaining({
        no_rebate: true,
        no_rebate_reason: status === 'blocked' ? 'binding_blocked' : 'auth_failed',
        result_code: 0,
      }),
    ]);
    expect(await f.links()).toEqual(before);
    await noAuthState(result, f);
  },
);

it('[AC-B1-06f#17] 复核失败 50303 后新幂等键无返利重开成功，不新增或改报价快照', async () => {
  const f = await setup(database());
  await f.bind('active');
  await f.promo();
  f.f.fetch.mockRejectedValue(new Error('synthetic detail unavailable'));
  const before = await f.links();
  const open = compose(f);
  await failure(await open(), f, 50303, 503);
  const result = await open(f.request({ noRebate: true }));
  const data = codeJump(result, f, 'self_buy', null);
  expect(data).toMatchObject({
    requote_failed: true,
    new_rebate_min_fen: 0,
    new_rebate_max_fen: 0,
    new_link_id: null,
    quoted_at: null,
  });
  expect(await f.links()).toEqual(before);
  expect(await f.logs()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ result_code: 50303, no_rebate: false }),
      expect.objectContaining({ result_code: 0, no_rebate: true }),
    ]),
  );
  expect(f.f.fetch).toHaveBeenCalled();
});

it.each([
  ['invalid', 30102],
  ['released', 30101],
  ['blocked', 30153],
] as const)(
  '[AC-B1-06f#18] 15 分钟内已缓存指令后绑定变 %s：授权失败 %i 优先于缓存与取价',
  async (status, code) => {
    const f = await setup(database());
    await f.bind('active');
    const open = compose(f);
    codeJump(await open(), f);
    const issued = await f.attempts();
    f.f.clock.advanceMs(3001);
    codeJump(await open(), f);
    expect((await f.logs()).at(-1)).toMatchObject({ cache_hit: true, result_code: 0 });
    const before = await f.attempts();
    expect(before.length).toBeGreaterThanOrEqual(issued.length);
    await f.db
      .updateTable('union_bindings')
      .set({
        status,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? f.f.clock.now() : null,
        cooldown_until: status === 'released' ? f.f.clock.now() : null,
      })
      .where('app_id', '=', f.appId)
      .where('user_id', '=', f.a)
      .execute();
    f.f.fetch.mockClear();
    const result = await open();
    expect(result).toMatchObject({ status: 422, envelope: { code } });
    expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
    expect(await f.attempts()).toEqual(before);
    expect(f.f.fetch).not.toHaveBeenCalled();
    if (status === 'blocked') await noAuthState(result, f);
    else {
      expect(result.envelope.data).toMatchObject({
        auth_url: expect.any(String),
        state: expect.any(String),
        auth_methods: ['web_code'],
      });
      expect(await f.sessions()).toHaveLength(1);
    }
  },
);

it.each([false, true])(
  '[AC-B1-06f#19] no_rebate=%s 先打开，正常与无返利缓存互不污染',
  async (firstNoRebate) => {
    const f = await setup(database());
    await f.bind('active');
    await f.promo();
    const open = compose(f);
    for (const noRebate of [firstNoRebate, !firstNoRebate, firstNoRebate]) {
      f.f.clock.advanceMs(3001);
      const result = await open(f.request({ noRebate }));
      if (noRebate) codeJump(result, f, 'self_buy', null);
      else urlJump(result);
    }
  },
);

it('[AC-B1-06f#20] 过 15 分钟仍是 active 时不复用旧 relation 指令，缓存不能跨快照用户', async () => {
  const f = await setup(database(), 'share');
  await f.bind('active');
  await f.bind('active', f.b);
  f.opener(f.b);
  const open = compose(f);
  codeJump(await open(), f, 'share');
  f.f.clock.advanceMs(900_001);
  await f.db
    .updateTable('union_bindings')
    .set({ relation_id: 'rel-A-new' })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a)
    .execute();
  codeJump(await open(), f, 'share', 'rel-A-new');
  // Opening one's own share changes identity/scene. The previous share cache must not escape.
  f.opener(f.a);
  codeJump(await open(), f, 'self_buy', 'rel-A-new');
});

it.each(['missing', 'invalid'] as const)(
  '[AC-B1-06f#21] 场景 active 推广位 %s：50301、告警，无指令或 state',
  async (kind) => {
    const f = await setup(database());
    await f.bind('active');
    if (kind === 'missing') f.getActivePid.mockResolvedValue(null);
    else
      f.getActivePid.mockImplementation(async (query) => ({
        id: randomUUID(),
        app_id: query.appId,
        platform: query.platform,
        pid_scene: query.pidScene,
        union_account_id: f.account,
        pid: 'synthetic-invalid-pid',
        status: 'active',
        row_version: 0,
        site_id: null,
        hjy_ignore_confirmed_at: null,
        hjy_ignore_evidence_path: null,
        created_at: f.f.clock.now(),
        updated_at: f.f.clock.now(),
      }));
    const result = await compose(f)();
    await failure(result, f, 50301, 503);
    await noAuthState(result, f);
    expect(f.warn).toHaveBeenCalledWith(
      expect.objectContaining({ app_id: f.appId, platform: 'taobao' }),
      expect.any(String),
    );
  },
);

it.each(['unbound', 'invalid', 'blocked', 'active'] as const)(
  '[AC-B1-06f#22] convert.enabled.taobao 关闭时 %s 先返回 50301，授权与取价都不能执行',
  async (status) => {
    const f = await setup(database());
    await f.bind(status);
    f.f.config.set('convert.enabled.taobao', false);
    const result = await compose(f)();
    await failure(result, f, 50301, 503);
    await noAuthState(result, f);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it.each(['active', 'unbound'] as const)(
  '[AC-B1-06f#23] prod 未验证淘宝路径，即使 %s 也先 50301、不下发授权或 SDK',
  async (status) => {
    const f = await setup(database());
    await f.bind(status);
    const result = await compose(f, {
      appEnv: 'prod',
      environment: { ...f.options.environment, appEnv: 'prod' },
    })();
    await failure(result, f, 50301, 503);
    await noAuthState(result, f);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it.each(['h5', 'web'] as const)(
  '[AC-B1-06f#24] %s 有我方推广链接时通过契约及 SDK 互斥不变量，不承诺回跳归因能力',
  async (client) => {
    const f = await setup(database());
    await f.bind('active');
    await f.promo();
    success(await compose(f)(f.request({ client })));
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06f#25] %s 无绑定仍能 open，所有步骤满足 type=sdk 当且仅当携带 sdk',
  async (platform) => {
    const f = await setup(database(), 'detail', platform);
    success(await compose(f)(f.request({ client: 'h5' })));
    expect(await f.sessions()).toEqual([]);
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
);

it.each(['unbound', 'invalid', 'blocked'] as const)(
  '[AC-B1-06f#26] %s 授权错误优先于详情复核失败，不能先取详情',
  async (status) => {
    const f = await setup(database());
    await f.bind(status as Binding);
    f.f.fetch.mockRejectedValue(new Error('synthetic detail unavailable'));
    const result = await compose(f)();
    await failure(result, f, status === 'blocked' ? 30153 : status === 'invalid' ? 30102 : 30101);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06f#27] 同 app 同商品同场景同 pid 的两位分享者不能互用指令缓存', async () => {
  const f = await setup(database(), 'share');
  await f.bind('active');
  await f.bind('active', f.b);
  const secondId = randomUUID();
  await f.db
    .insertInto('links')
    .values({
      ...f.row,
      link_id: secondId,
      user_id: f.b,
      identity_snapshot: JSON.stringify({
        ...(f.row.identity_snapshot as Record<string, unknown>),
        user_id: f.b,
        attr_code: 'demo0002',
      }),
    })
    .execute();
  f.opener(null);
  const open = compose(f);
  codeJump(await open(), f, 'share');
  codeJump(await open(f.request({ linkId: secondId })), f, 'share', 'rel-B');
  f.f.clock.advanceMs(3001);
  codeJump(await open(), f, 'share');
  const keys = f.f.cache.put.mock.calls.map(([key]) => key);
  expect(keys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ appId: f.appId, userId: f.a, pidScene: 'share', noRebate: false }),
      expect.objectContaining({ appId: f.appId, userId: f.b, pidScene: 'share', noRebate: false }),
    ]),
  );
});

it('[AC-B1-06f#28] 本人 invalid 绑定账号 expired，当前推广位的另一个有效账号不能掩盖', async () => {
  const f = await setup(database());
  await f.bind('invalid');
  await expireAccount(f);
  const other = await f.db
    .selectFrom('union_accounts')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('auth_status', '=', 'active')
    .executeTakeFirstOrThrow();
  const original = f.getActivePid.getMockImplementation()!;
  f.getActivePid.mockImplementation(async (query) => {
    const row = await original(query);
    return row === null ? null : { ...row, union_account_id: other.id };
  });
  const result = await compose(f)();
  await failure(result, f, 30102);
  expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
  await noAuthState(result, f);
  expect(f.f.fetch).not.toHaveBeenCalled();
});

it('[AC-B1-06f#29] 分享 promo 按 W_link 有效，临近到期下发的 URL 缓存也不能越过到期时刻', async () => {
  const f = await setup(database(), 'share');
  await f.bind('active');
  await f.promo();
  f.opener(f.b);
  // A share link lasts longer than the instruction cache. Its old fetched_at is not a 15-minute TTL.
  f.f.clock.set(new Date(new Date(f.row.expire_at).getTime() - 1).toISOString());
  const open = compose(f);
  urlJump(await open());
  f.f.clock.advanceMs(1);
  const result = await open();
  codeJump(result, f, 'share');
  expect(JSON.stringify(result)).not.toContain(PROMO);
});

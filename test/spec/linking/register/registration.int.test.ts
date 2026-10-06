import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  createCardAssembler,
  type LinkRegistrar,
  type SourceLinkReader,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createGuestCallerContext,
  createLinkRegistration,
} from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createUnionPidService,
  DemoUnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  DEVICE_A,
  DEVICE_B,
  QUOTED,
  RAW_AT,
  SESSION,
  START,
  USER_A,
  USER_B,
  caller,
  fixture,
  input,
  logs,
  pid,
  seed,
  stored,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  await seed(db);
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-06c#3] BR-PRICE-12/PROD-05：catalog 端口登记真实 link，原串、价格、券与各自时刻原样落库', async () => {
  const f = fixture(db);
  const registrar: LinkRegistrar = f.service;
  const request = input();
  const { linkId } = await registrar.register(request);
  expect(linkId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(await stored(db, linkId)).toMatchObject({
    app_id: 'register-app',
    user_id: USER_A,
    device_id: DEVICE_A,
    platform: 'taobao',
    product_key: request.ref.productKey,
    raw_item_id: request.ref.rawItemId,
    raw_fetched_at: new Date(RAW_AT),
    scene: 'search',
    pid_scene: 'self_buy',
    pid: 'synthetic-self_buy',
    entry_source: 'search',
    quoted_final_price_fen: 10000n,
    quoted_coupon_fen: 2000n,
    quoted_coupon_id: 'coupon-a,coupon-z',
    quoted_at: new Date(QUOTED),
    created_at: new Date(START),
    updated_at: new Date(START),
    row_version: 0,
    convert_result: null,
    cache_hit: false,
  });
  expect(request.item.coupon_ids).toBe('coupon-a,coupon-z');
  expect(await logs(db, linkId)).toEqual([]);
});

it.each([
  ['search', 'self_buy'],
  ['detail', 'self_buy'],
  ['home_card', 'self_buy'],
  ['feed', 'self_buy'],
  ['clipboard', 'self_buy'],
  ['h5', 'self_buy'],
  ['push', 'self_buy'],
  ['agent', 'agent'],
  ['share', 'share'],
  ['watch_alert', 'self_buy'],
  ['share_ext', 'self_buy'],
  ['wechat_bot', 'self_buy'],
  ['mcp', 'agent'],
])(
  '[AC-B1-06c#4] BR-ATTR-08：scene=%s 推出 %s，entry_source 不能改变推广位场景',
  async (scene, pidScene) => {
    const f = fixture(db, { context: { scene } });
    const { linkId } = await f.service.register(input({ entrySource: 'feed' }));
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: 'register-app',
      platform: 'taobao',
      pidScene,
      purpose: 'convert',
    });
    expect(await stored(db, linkId)).toMatchObject({
      scene,
      pid_scene: pidScene,
      pid: `synthetic-${pidScene}`,
      entry_source: 'feed',
      identity_snapshot: {
        user_id: USER_A,
        platform: 'taobao',
        pid_scene: pidScene,
        pid: `synthetic-${pidScene}`,
      },
    });
  },
);

it('[AC-B1-06c#4] BR-ATTR-08：tlj.enabled=on 时 taolijin 登记成功并固化淘礼金推广位', async () => {
  const configValue = vi.fn(async (appId: string, key: string) =>
    appId === 'register-app' && key === 'tlj.enabled' ? { value: 'on', version: 1 } : null,
  );
  const f = fixture(db, { context: { scene: 'taolijin' }, config: { configValue } });
  const { linkId } = await f.service.register(input({ entrySource: 'feed' }));
  expect(configValue).toHaveBeenCalledWith('register-app', 'tlj.enabled');
  expect(f.getActivePid).toHaveBeenCalledWith({
    appId: 'register-app',
    platform: 'taobao',
    pidScene: 'taolijin',
    purpose: 'convert',
  });
  expect(await stored(db, linkId)).toMatchObject({
    scene: 'taolijin',
    pid_scene: 'taolijin',
    pid: 'synthetic-taolijin',
    entry_source: 'feed',
    identity_snapshot: {
      user_id: USER_A,
      platform: 'taobao',
      pid_scene: 'taolijin',
      pid: 'synthetic-taolijin',
    },
  });
});

it('[AC-B1-06c#27] tlj.enabled 未配置默认关闭：taolijin 返回 20001 且不写 links', async () => {
  const f = fixture(db);
  const before = await db.selectFrom('links').select('link_id').execute();
  const outcome = await Promise.resolve()
    .then(() => {
      const service = createLinkRegistration({ ...f.options, context: { scene: 'taolijin' } });
      return service.register(input({ entrySource: 'feed' }));
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  expect(outcome).toMatchObject({ error: { code: 20001 } });
  expect(f.configValue).toHaveBeenCalled();
  expect(await db.selectFrom('links').select('link_id').execute()).toEqual(before);
});

it.each(['', 'fallback', 'query', 'SEARCH', 'unknown', undefined, null])(
  '[AC-B1-06c#5] BR-ATTR-08：非法或缺失 scene=%s 返回 20001，不能登记',
  async (scene) => {
    // Factory construction is deliberately outside rejects: the skeleton cannot false-pass.
    const f = fixture(db);
    const before = await db.selectFrom('links').select('link_id').execute();
    await expect(
      (async () => {
        const service = createLinkRegistration({
          ...f.options,
          context: { scene: scene as string },
        });
        return service.register(input());
      })(),
    ).rejects.toMatchObject({ code: 20001 });
    expect(await db.selectFrom('links').select('link_id').execute()).toEqual(before);
    expect(f.getActivePid).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06c#6] BR-ATTR-05：忽略伪造 viewer 与所有外部身份参数，固化服务端用户、推广位及 Agent 上下文', async () => {
  const f = fixture(db, {
    context: { scene: 'agent', agentSessionId: SESSION, agentCardId: 'card-demo' },
  });
  const forged = {
    ...input(),
    viewer: caller({ userId: USER_B, deviceId: DEVICE_B, appId: 'forged-app' }),
    user_id: USER_B,
    pid: 'forged-pid',
    pid_scene: 'share',
    relation_id: 'forged-relation',
    subUnionId: 'forged-sub',
    custom_parameters: { uid: 'forged-attr' },
    sid: 'forged-sid',
    attr_code: 'forged00',
    agent_session_id: USER_B,
    identity_snapshot: { user_id: USER_B, pid: 'forged-pid' },
  };
  const { linkId } = await f.service.register(forged);
  const row = await stored(db, linkId);
  expect(row).toMatchObject({
    app_id: 'register-app',
    user_id: USER_A,
    device_id: DEVICE_A,
    agent_session_id: SESSION,
    agent_card_id: 'card-demo',
    identity_snapshot: {
      user_id: USER_A,
      platform: 'taobao',
      pid: 'synthetic-agent',
      pid_scene: 'agent',
      agent_session_id: SESSION,
    },
  });
  expect(JSON.stringify(row.identity_snapshot)).not.toContain('forged');
  expect(JSON.stringify(row.identity_snapshot)).not.toContain(USER_B);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06c#7] BR-ATTR-06：%s 快照采用本应用 attr_code，绝不把 user_id 当联盟用户参数',
  async (platform) => {
    const f = fixture(db);
    const base = input();
    const { linkId } = await f.service.register(
      input({
        item: { ...base.item, platform },
        ref: { ...base.ref, platform, productKey: `${platform}:${base.ref.productKey}` },
      }),
    );
    expect(f.attrCode).toHaveBeenCalledWith('register-app', USER_A);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: 'register-app',
      platform,
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    const row = await stored(db, linkId);
    expect(row.identity_snapshot).toMatchObject({
      user_id: USER_A,
      platform,
      attr_code: 'demo0001',
    });
    const snapshot = row.identity_snapshot as Record<string, unknown>;
    const { user_id: owner, ...parameters } = snapshot;
    expect(owner).toBe(USER_A);
    expect(JSON.stringify(parameters)).not.toContain(USER_A);
  },
);

it.each(['null', 'unwired'] as const)(
  '[AC-B1-06c#8] BR-ATTR-06：attr_code %s 仍能出卡，快照不以 user_id 兜底',
  async (mode) => {
    const f = fixture(db);
    f.attrCode.mockResolvedValue(null);
    const { attrCodes, ...withoutAttrCodes } = f.options;
    expect(attrCodes).toBeDefined();
    const service = mode === 'unwired' ? createLinkRegistration(withoutAttrCodes) : f.service;
    const base = input();
    const { linkId } = await service.register(
      input({
        item: { ...base.item, platform: 'jd' },
        ref: { ...base.ref, platform: 'jd', productKey: `jd:${base.ref.productKey}` },
      }),
    );
    const snapshot = (await stored(db, linkId)).identity_snapshot as Record<string, unknown>;
    expect(snapshot['user_id']).toBe(USER_A);
    expect(snapshot['attr_code'] ?? null).toBeNull();
    const { user_id: owner, ...parameters } = snapshot;
    expect(owner).toBe(USER_A);
    expect(JSON.stringify(parameters)).not.toContain(USER_A);
  },
);

it('[AC-B1-06c#9] BR-PRICE-12：默认 CallerContext 下伪造登录信息也只能生成游客 link，不查询用户归因码', async () => {
  const f = fixture(db);
  const callerContext = createGuestCallerContext({ ...caller(), userId: USER_B } as ReturnType<
    typeof caller
  >);
  const service = createLinkRegistration({ ...f.options, callerContext });
  const { linkId } = await service.register(input());
  const row = await stored(db, linkId);
  expect(row).toMatchObject({
    user_id: null,
    device_id: DEVICE_A,
    quoted_final_price_fen: 10000n,
    convert_result: null,
  });
  expect(f.attrCode).not.toHaveBeenCalled();
  expect(JSON.stringify(row.identity_snapshot)).not.toContain(USER_A);
  expect(JSON.stringify(row.identity_snapshot)).not.toContain(USER_B);
});

it('[AC-B1-06c#10] 无 active 推广位仍登记，pid 为空且不能用 fallback/query 或外部 pid 补齐', async () => {
  const f = fixture(db);
  f.getActivePid.mockResolvedValue(null);
  const forged = { ...input(), pid: 'forged-fallback', pid_scene: 'fallback' };
  const { linkId } = await f.service.register(forged);
  expect(await stored(db, linkId)).toMatchObject({
    pid: null,
    pid_scene: 'self_buy',
    identity_snapshot: { pid: null, pid_scene: 'self_buy' },
  });
  expect(
    f.getActivePid.mock.calls.every(
      ([query]) => query.pidScene === 'self_buy' && query.purpose === 'convert',
    ),
  ).toBe(true);
});

it.each([
  ['search', 900_000],
  ['agent', 900_000],
  ['share', 604_800_000],
] as const)(
  '[AC-B1-06c#11] BR-ATTR-05：%s 的 expire_at 为登记时刻加 %i 毫秒，不从报价时刻起算',
  async (scene, lifetime) => {
    const f = fixture(db, { context: { scene } });
    f.clock.advanceMs(1234);
    const { linkId } = await f.service.register(input());
    const row = await stored(db, linkId);
    expect(row.expire_at.getTime()).toBe(Date.parse(START) + 1234 + lifetime);
    expect(row.quoted_at).toEqual(new Date(QUOTED));
  },
);

it.each([
  {
    change: 'final',
    price_fen: 12001n,
    coupon_fen: 2000n,
    final_price_fen: 10001n,
    coupon_ids: 'coupon-a,coupon-z',
  },
  {
    change: 'coupon amount',
    price_fen: 12001n,
    coupon_fen: 2001n,
    final_price_fen: 10000n,
    coupon_ids: 'coupon-a,coupon-z',
  },
  {
    change: 'coupon identity',
    price_fen: 12000n,
    coupon_fen: 2000n,
    final_price_fen: 10000n,
    coupon_ids: 'coupon-new',
  },
])(
  '[AC-B1-06c#12] D33/BR-PRICE-12：只改变 $change 也必须新建 link，旧报价和身份快照不变',
  async ({ change, ...prices }) => {
    const f = fixture(db);
    const first = await f.service.register(input());
    const before = await stored(db, first.linkId);
    f.clock.advanceMs(1);
    const second = await f.service.register(input({ item: { ...input().item, ...prices } }));
    expect(second.linkId, change).not.toBe(first.linkId);
    expect(await stored(db, first.linkId)).toEqual(before);
    expect(await stored(db, second.linkId)).toMatchObject({
      quoted_final_price_fen: prices.final_price_fen,
      quoted_coupon_fen: prices.coupon_fen,
      quoted_coupon_id: prices.coupon_ids,
    });
  },
);

it('[AC-B1-06c#13] D33：完整保存上游已排序的券串；相同快照可以复用或新建，但不得改写原快照时间', async () => {
  const f = fixture(db);
  const item = { ...input().item, coupon_ids: 'coupon-10,coupon-2,coupon-A,coupon-a' };
  const first = await f.service.register(input({ item }));
  const before = await stored(db, first.linkId);
  f.clock.advanceMs(1000);
  const second = await f.service.register(input({ item: { ...item } }));
  expect(await stored(db, first.linkId)).toEqual(before);
  expect(await stored(db, second.linkId)).toMatchObject({
    quoted_coupon_id: 'coupon-10,coupon-2,coupon-A,coupon-a',
    quoted_at: new Date(QUOTED),
  });
});

it.each(['user', 'device', 'app', 'product', 'entry source'] as const)(
  '[AC-B1-06c#14] BR-PRICE-12：%s 不同的卡不能复用旧 link',
  async (dimension) => {
    const f = fixture(db);
    if (dimension === 'device') f.current.mockResolvedValue(caller({ userId: null }));
    const first = await f.service.register(input());
    let next = input();
    if (dimension === 'user') f.current.mockResolvedValue(caller({ userId: USER_B }));
    if (dimension === 'device')
      f.current.mockResolvedValue(caller({ userId: null, deviceId: DEVICE_B }));
    if (dimension === 'app') {
      f.current.mockResolvedValue(
        caller({ appId: 'register-other-app', userId: null, deviceId: null }),
      );
      next = input({ ref: { ...next.ref, appId: 'register-other-app' } });
    }
    if (dimension === 'product')
      next = input({ ref: { ...next.ref, productKey: 'tb:other-synthetic' } });
    if (dimension === 'entry source') next = input({ entrySource: 'feed' });
    const second = await f.service.register(next);
    expect(second.linkId).not.toBe(first.linkId);
    expect((await stored(db, first.linkId)).entry_source).toBe('search');
    const row = await stored(db, second.linkId);
    if (dimension === 'user') expect(row.user_id).toBe(USER_B);
    if (dimension === 'device') expect(row.device_id).toBe(DEVICE_B);
    if (dimension === 'app') expect(row.app_id).toBe('register-other-app');
    if (dimension === 'product') expect(row.product_key).toBe('tb:other-synthetic');
    if (dimension === 'entry source') expect(row.entry_source).toBe('feed');
  },
);

it.each([900_000, 900_001])(
  '[AC-B1-06c#15] BR-PRICE-12：登记后 %i 毫秒的已过期 link 不能用于新出卡复用',
  async (elapsed) => {
    const f = fixture(db);
    const first = await f.service.register(input());
    const before = await stored(db, first.linkId);
    f.clock.advanceMs(elapsed);
    const second = await f.service.register(input());
    expect(second.linkId).not.toBe(first.linkId);
    expect(await stored(db, first.linkId)).toEqual(before);
  },
);

it('[AC-B1-06c#16] 并发不同报价均有对应持久化快照，不能相互覆盖或把一个 ID 给两种价格', async () => {
  const first = fixture(db);
  const second = createLinkRegistration(first.options);
  const requests = [
    input(),
    input({ item: { ...input().item, price_fen: 13000n, final_price_fen: 11000n } }),
  ];
  const results = await Promise.all([
    first.service.register(requests[0]!),
    second.register(requests[1]!),
  ]);
  expect(results[0]!.linkId).not.toBe(results[1]!.linkId);
  for (const [index, result] of results.entries()) {
    expect(await stored(db, result.linkId)).toMatchObject({
      quoted_final_price_fen: requests[index]!.item.final_price_fen,
      row_version: 0,
    });
  }
});

it('[AC-B1-06c#17] BR-ATTR-05：后续请求身份和推广位变化不能修改已登记 identity_snapshot', async () => {
  const f = fixture(db);
  const first = await f.service.register(input());
  const before = await stored(db, first.linkId);
  f.current.mockResolvedValue(caller({ userId: USER_B }));
  f.attrCode.mockResolvedValue('demo0002');
  f.getActivePid.mockImplementation(async (query) => ({
    ...pid(query),
    pid: 'synthetic-replacement',
  }));
  const second = await f.service.register(input());
  expect(await stored(db, first.linkId)).toEqual(before);
  expect(await stored(db, second.linkId)).toMatchObject({
    user_id: USER_B,
    pid: 'synthetic-replacement',
    identity_snapshot: { user_id: USER_B, pid: 'synthetic-replacement' },
  });
});

it('[AC-B1-06c#18] BR-PRICE-07：SourceLinkReader 按 app 隔离且只读，过期后仍返回原始来源', async () => {
  const f = fixture(db);
  const source: SourceLinkReader = f.service;
  const { linkId } = await f.service.register(input({ entrySource: 'opaque-source/原样' }));
  const before = await stored(db, linkId);
  const beforeLogs = await logs(db, linkId);
  f.clock.advanceMs(900_001);
  expect(await source.entrySource('register-app', linkId)).toBe('opaque-source/原样');
  expect(await source.entrySource('other-app', linkId)).toBeNull();
  expect(
    await source.entrySource('register-app', '0199a3b4-5c6d-7000-8000-000000000099'),
  ).toBeNull();
  expect(await stored(db, linkId)).toEqual(before);
  expect(await logs(db, linkId)).toEqual(beforeLogs);
});

it('[AC-B1-06c#19] BR-PRICE-07：catalog 派生详情卡继承来源，link 的 scene 保持 detail', async () => {
  const f = fixture(db);
  const origin = await f.service.register(input({ entrySource: 'feed' }));
  const detail = createLinkRegistration({ ...f.options, context: { scene: 'detail' } });
  const assembler = createCardAssembler({
    clock: f.clock,
    viewerContext: { current: f.current },
    registrar: detail,
    sourceLinks: detail,
    quoter: { quote: async () => input().quote },
    itemRefs: { issue: () => 'synthetic-item-ref' },
  });
  const card = await assembler.assemble({
    ...input(),
    entrySource: 'detail',
    sourceLinkId: origin.linkId,
    stale: false,
  });
  expect(await stored(db, card.link_id)).toMatchObject({
    entry_source: 'feed',
    scene: 'detail',
    pid_scene: 'self_buy',
  });
  expect(card.rebate_basis).toBe('normal');
});

it.each(['agent', 'watch_alert', 'search', 'detail', 'clipboard', 'home_card', 'share'])(
  '[AC-B1-06c#20] BR-ATTR-14：%s 只有 Agent/提醒出卡记 register，不能生成点击或预转链日志',
  async (scene) => {
    const f = fixture(db, {
      context: { scene, agentSessionId: scene === 'agent' ? SESSION : null },
    });
    const { linkId } = await f.service.register(input({ entrySource: scene }));
    const events = await logs(db, linkId);
    if (scene === 'agent' || scene === 'watch_alert') {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'register',
        app_id: 'register-app',
        user_id: USER_A,
        result_code: 0,
        created_at: new Date(START),
        quoted_price_fen: 10000n,
      });
    } else {
      expect(events).toEqual([]);
    }
    expect(events.every((event) => event.event === 'register')).toBe(true);
    expect(await stored(db, linkId)).toMatchObject({ convert_result: null, cache_hit: false });
    expect(
      await db.selectFrom('link_open_attempts').selectAll().where('link_id', '=', linkId).execute(),
    ).toEqual([]);
  },
);

it('[AC-B1-06c#21] 通过 union 公共查询取最早 active 推广位，忽略其他场景和非 active', async () => {
  const f = fixture(db);
  const accountId = '0199a3b4-5c6d-7000-8000-000000000020';
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: 'register-app',
      platform: 'jd',
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
      created_at: RAW_AT,
      updated_at: RAW_AT,
    })
    .execute();
  const candidates = [
    {
      name: 'newer',
      app: 'register-app',
      platform: 'jd',
      scene: 'self_buy',
      status: 'active',
      instant: QUOTED,
    },
    {
      name: 'earliest',
      app: 'register-app',
      platform: 'jd',
      scene: 'self_buy',
      status: 'active',
      instant: RAW_AT,
    },
    {
      name: 'retired',
      app: 'register-app',
      platform: 'jd',
      scene: 'self_buy',
      status: 'retired',
      instant: '2030-01-01T00:00:00Z',
    },
    {
      name: 'pending',
      app: 'register-app',
      platform: 'jd',
      scene: 'self_buy',
      status: 'pending',
      instant: '2030-01-01T00:00:00Z',
    },
    {
      name: 'share',
      app: 'register-app',
      platform: 'jd',
      scene: 'share',
      status: 'active',
      instant: RAW_AT,
    },
    {
      name: 'fallback',
      app: 'register-app',
      platform: 'jd',
      scene: 'fallback',
      status: 'active',
      instant: RAW_AT,
    },
    {
      name: 'query',
      app: 'register-app',
      platform: 'jd',
      scene: 'query',
      status: 'active',
      instant: RAW_AT,
    },
  ];
  for (const [index, candidate] of candidates.entries()) {
    await db
      .insertInto('union_pids')
      .values({
        id: `0199a3b4-5c6d-7000-8000-${String(30 + index).padStart(12, '0')}`,
        app_id: candidate.app,
        platform: candidate.platform,
        union_account_id: accountId,
        pid: `synthetic-${candidate.name}`,
        pid_scene: candidate.scene,
        status: candidate.status,
        created_at: candidate.name === 'newer' ? '2030-01-01T00:00:00Z' : candidate.instant,
        updated_at: candidate.instant,
        hjy_ignore_confirmed_at: RAW_AT,
        hjy_ignore_evidence_path: 'synthetic-evidence',
      })
      .execute();
  }
  const verify = vi.fn(async () => null);
  const append = vi.fn(async () => undefined);
  const pids = createUnionPidService({
    db,
    clock: f.clock,
    superVerifier: { verify },
    auditWriter: () => ({ append }),
  });
  const service = createLinkRegistration({ ...f.options, pids });
  const base = input();
  const { linkId } = await service.register(
    input({
      item: { ...base.item, platform: 'jd' },
      ref: { ...base.ref, platform: 'jd', productKey: 'jd:pid-selection' },
    }),
  );
  expect(await stored(db, linkId)).toMatchObject({
    pid: 'synthetic-earliest',
    identity_snapshot: { pid: 'synthetic-earliest' },
  });
  expect(verify).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('[AC-B1-06c#22] 无券快照保持零券额；之后出现券必须新建，不补写旧快照的空券 ID', async () => {
  const f = fixture(db);
  const { coupon_ids, ...withoutCouponIds } = input().item;
  expect(coupon_ids).toBeDefined();
  const first = await f.service.register(
    input({
      item: { ...withoutCouponIds, coupon_fen: 0n, price_fen: 10000n },
      entrySource: null,
    }),
  );
  const before = await stored(db, first.linkId);
  expect(before).toMatchObject({
    quoted_coupon_fen: 0n,
    quoted_coupon_id: null,
    entry_source: null,
  });
  expect(await f.service.entrySource('register-app', first.linkId)).toBeNull();
  const second = await f.service.register(input({ entrySource: null }));
  expect(second.linkId).not.toBe(first.linkId);
  expect(await stored(db, first.linkId)).toEqual(before);
});

it.each(['flag', 'zero price'] as const)(
  '[AC-B1-06c#23] D33：catalog 入口遇价格异常 %s 不得登记 link 或返回可购买卡',
  async (anomaly) => {
    const f = fixture(db);
    const assembler = createCardAssembler({
      clock: f.clock,
      viewerContext: { current: f.current },
      registrar: f.service,
      sourceLinks: f.service,
      quoter: { quote: async () => input().quote },
      itemRefs: { issue: () => 'synthetic-item-ref' },
    });
    const request = input({ entrySource: 'feed' });
    const before = await db.selectFrom('links').select('link_id').execute();
    const item =
      anomaly === 'flag'
        ? { ...request.item, price_status: 'anomaly' as const }
        : { ...request.item, price_fen: 0n, coupon_fen: 0n, final_price_fen: 0n };
    await expect(assembler.assemble({ ...request, item, stale: false })).rejects.toThrow();
    expect(await db.selectFrom('links').select('link_id').execute()).toEqual(before);
  },
);

it('[AC-B1-06c#24] 未登录且无设备的调用也能登记，只保存空用户/设备与本次报价', async () => {
  const f = fixture(db);
  f.current.mockResolvedValue(caller({ userId: null, deviceId: null }));
  const { linkId } = await f.service.register(input());
  expect(await stored(db, linkId)).toMatchObject({
    user_id: null,
    device_id: null,
    quoted_final_price_fen: 10000n,
    convert_result: null,
  });
  expect(f.attrCode).not.toHaveBeenCalled();
});

it.each(['clipboard', 'agent', 'guest'] as const)(
  '[AC-B1-06c#25] BR-PRICE-12：T1 粘贴、Agent 第一张卡和游客卡（%s）出卡都不调用转链',
  async (entry) => {
    const f = fixture(db, {
      context: {
        scene: entry === 'guest' ? 'search' : entry,
        agentCardId: entry === 'agent' ? 'first-card' : null,
      },
    });
    const convert = vi
      .spyOn(DemoUnionAdapter.prototype, 'convert')
      .mockRejectedValue(new Error('unexpected card conversion'));
    if (entry === 'guest') f.current.mockResolvedValue(caller({ userId: null }));
    const { linkId } = await f.service.register(
      input({ entrySource: entry === 'clipboard' ? 'parse' : entry }),
    );
    expect(convert).not.toHaveBeenCalled();
    expect(await stored(db, linkId)).toMatchObject({
      convert_result: null,
      cache_hit: false,
      quoted_final_price_fen: 10000n,
    });
    expect((await logs(db, linkId)).every((row) => row.event === 'register')).toBe(true);
  },
);

it('[AC-B1-06c#26] BR-ATTR-08：提醒细分只存 sub_scene，不影响 watch_alert 自购位和来源', async () => {
  const f = fixture(db, { context: { scene: 'watch_alert', subScene: 'digest' } });
  const { linkId } = await f.service.register(input({ entrySource: 'feed' }));
  expect(await stored(db, linkId)).toMatchObject({
    scene: 'watch_alert',
    sub_scene: 'digest',
    pid_scene: 'self_buy',
    entry_source: 'feed',
  });
  expect(await logs(db, linkId)).toMatchObject([{ event: 'register', scene: 'watch_alert' }]);
});

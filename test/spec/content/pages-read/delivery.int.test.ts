import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { headers } from '../config/kit.ts';
import { row, seed } from '../app-versions/kit.ts';
import {
  FULL,
  GRAY,
  appId,
  bucket,
  deviceAt,
  harness,
  read,
  registerDevice,
  rejected,
  seedPage,
  session,
  success,
  validate,
  type Harness,
} from './kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

it('[AC-F1-09d#1] 无页面、合法但不存在的 custom:x、只有草稿均为 30701', async () => {
  const id = appId();
  await rejected(await read(h.app, id), 30701);
  await rejected(await read(h.app, id, 'custom:x'), 30701);
  const draft = appId();
  await seedPage(h, draft, {
    current: null,
    versions: [{ number: 1, status: 'draft', sections: FULL }],
  });
  await rejected(await read(h.app, draft), 30701);
});

it.each(['HOME', 'custom:', 'custom:A', `custom:${'a'.repeat(58)}`, 'a'.repeat(65)])(
  '[AC-F1-09d#2] 非法 page_key %s 返回 20001 且 fields 仅为 page_key',
  async (key) => {
    await rejected(await read(h.app, appId(), key), 20001);
  },
);

it.each(['home', 'custom:x', `custom:${'a'.repeat(57)}`])(
  '[AC-F1-09d#3] %s 无设备号、无令牌、无签名取指针全量版，ttl 固定 300',
  async (key) => {
    const id = appId();
    await seedPage(h, id, {
      key,
      versions: [
        { number: 1, sections: FULL },
        { number: 2, sections: GRAY },
      ],
    });
    expect(await success(h.app, id, key)).toEqual({
      page_key: key,
      version: 1,
      ttl_sec: 300,
      sections: FULL,
    });
  },
);

it.each(['draft', 'rolled_back'] as const)(
  '[AC-F1-09d#4] 指针指向 %s 不下发，即便另有 published 版本也不回退',
  async (status) => {
    const id = appId();
    await seedPage(h, id, {
      current: 2,
      versions: [
        { number: 1, sections: FULL },
        { number: 2, status, sections: GRAY },
      ],
    });
    await rejected(await read(h.app, id), 30701);
  },
);

it('[AC-F1-09d#5] sha256 前八字节桶 k−1 命中灰度、k 命中全量，重复请求一致', async () => {
  const id = appId();
  await seedPage(h, id, {
    gray: 2,
    percent: 37,
    versions: [
      { number: 1, sections: FULL },
      { number: 2, sections: GRAY },
    ],
  });
  const low = deviceAt(id, 3699);
  const high = deviceAt(id, 3700);
  expect([bucket(id, low), bucket(id, high)]).toEqual([3699, 3700]);
  for (let i = 0; i < 3; i += 1) {
    expect(await success(h.app, id, 'home', { 'x-device-id': low })).toEqual({
      page_key: 'home',
      version: 2,
      ttl_sec: 300,
      sections: GRAY,
    });
    expect(await success(h.app, id, 'home', { 'x-device-id': high })).toEqual({
      page_key: 'home',
      version: 1,
      ttl_sec: 300,
      sections: FULL,
    });
  }
});

it('[AC-F1-09d#6] 无设备头在 99% 灰度下仍取全量，登录也不退回 user_id 分桶', async () => {
  const id = appId();
  await seedPage(h, id, {
    gray: 2,
    percent: 99,
    versions: [
      { number: 1, sections: FULL },
      { number: 2, sections: GRAY },
    ],
  });
  const registered = await registerDevice(h, id);
  let login = await session(h, id, registered);
  // Ensure a user_id fallback would select gray, rather than occasionally passing by chance.
  for (let i = 0; i < 100 && bucket(id, login.user.id) >= 9900; i += 1) {
    login = await session(h, id, registered);
  }
  expect(bucket(id, login.user.id)).toBeLessThan(9900);
  expect((await success(h.app, id)).sections).toEqual(FULL);
  expect((await success(h.app, id, 'home', login.headers)).sections).toEqual(FULL);
});

it('[AC-F1-09d#7] 同设备换登录用户、或移除令牌，灰度版本保持一致', async () => {
  const id = appId();
  await seedPage(h, id, {
    gray: 2,
    percent: 37,
    versions: [
      { number: 1, sections: FULL },
      { number: 2, sections: GRAY },
    ],
  });
  const registered = await registerDevice(h, id);
  const first = await session(h, id, registered);
  const second = await session(h, id, registered);
  expect(first.user.id).not.toBe(second.user.id);
  for (const [target, expected] of [
    [3699, GRAY],
    [3700, FULL],
  ] as const) {
    const device = deviceAt(id, target);
    for (const auth of [{}, first.headers, second.headers]) {
      expect(
        (await success(h.app, id, 'home', { ...auth, 'x-device-id': device })).sections,
      ).toEqual(expected);
    }
  }
});

it('[AC-F1-09d#8] 灰度命中未发布版本时 30701，不静默降到全量', async () => {
  const id = appId();
  await seedPage(h, id, {
    gray: 2,
    percent: 37,
    versions: [
      { number: 1, sections: FULL },
      { number: 2, status: 'rolled_back', sections: GRAY },
    ],
  });
  await rejected(await read(h.app, id, 'home', { 'x-device-id': deviceAt(id, 3699) }), 30701);
  expect((await success(h.app, id)).sections).toEqual(FULL);
});

it('[AC-F1-09d#9] 每端按自身门槛过滤且等值可见，h5 不过滤，响应过滤不缓存', async () => {
  const id = appId();
  const gated = {
    id: 'gated',
    min_app_version: { ios: '2.0.0', android: '3.0.0', harmony: '4.0.0' },
  };
  await seedPage(h, id, { versions: [{ number: 1, sections: [FULL[0]!, gated] }] });
  for (const [platform, low, equal] of [
    ['ios', '1.9.9', '2.0.0'],
    ['android', '2.9.9', '3.0.0'],
    ['harmony', '3.9.9', '4.0.0'],
  ]) {
    expect(
      (await success(h.app, id, 'home', { 'x-platform': platform!, 'x-app-version': low! }))
        .sections,
    ).toEqual(FULL);
    expect(
      (await success(h.app, id, 'home', { 'x-platform': platform!, 'x-app-version': equal! }))
        .sections,
    ).toEqual([...FULL, gated]);
  }
  expect(
    (await success(h.app, id, 'home', { 'x-platform': 'h5', 'x-app-version': '0.0.1' })).sections,
  ).toEqual([...FULL, gated]);
});

it('[AC-F1-09d#10] login yes/no/any 每次按令牌判定，暂未接入的人群条件不下发', async () => {
  const id = appId();
  const yes = { id: 'yes', condition: { login: 'yes' } };
  const no = { id: 'no', condition: { login: 'no' } };
  const any = {
    id: 'any',
    condition: { login: 'any', has_parent: 'any', union_authorized: 'any', has_order: 'any' },
  };
  const deferred = [
    { id: 'parent', condition: { has_parent: 'yes' } },
    { id: 'union', condition: { union_authorized: 'no' } },
    { id: 'order', condition: { has_order: 'yes' } },
  ];
  await seedPage(h, id, {
    versions: [{ number: 1, sections: [yes, no, any, ...deferred, ...FULL] }],
  });
  const login = await session(h, id, await registerDevice(h, id));
  expect((await success(h.app, id)).sections).toEqual([no, any, ...FULL]);
  expect((await success(h.app, id, 'home', login.headers)).sections).toEqual([yes, any, ...FULL]);
  expect((await success(h.app, id)).sections).toEqual([no, any, ...FULL]);
});

it('[AC-F1-09d#11] 过滤后为空仍返回 200 和 sections []', async () => {
  const id = appId();
  await seedPage(h, id, { versions: [{ number: 1, sections: [{ condition: { login: 'yes' } }] }] });
  expect(await success(h.app, id)).toEqual({
    page_key: 'home',
    version: 1,
    ttl_sec: 300,
    sections: [],
  });
});

it('[AC-F1-09d#12] deletion_only 返回 10405，游客仍可读', async () => {
  const id = appId();
  await seedPage(h, id);
  const restricted = await session(h, id, await registerDevice(h, id), 'deletion_only');
  expect((await success(h.app, id)).sections).toEqual(FULL);
  await rejected(await read(h.app, id, 'home', restricted.headers), 10405);
});

it('[AC-F1-09d#13] 修改指针后 59999ms 仍旧版，到 60000ms 刷新且命中不续期', async () => {
  const id = appId();
  await seedPage(h, id, {
    versions: [
      { number: 1, sections: FULL },
      { number: 2, sections: GRAY },
    ],
  });
  expect((await success(h.app, id)).version).toBe(1);
  await db
    .withSchema('app')
    .updateTable('pages')
    .set({ current_version: 2 })
    .where('app_id', '=', id)
    .where('page_key', '=', 'home')
    .execute();
  h.deps.clock.advanceMs(59_999);
  expect((await success(h.app, id)).sections).toEqual(FULL);
  h.deps.clock.advanceMs(1);
  expect(await success(h.app, id)).toEqual({
    page_key: 'home',
    version: 2,
    ttl_sec: 300,
    sections: GRAY,
  });
});

it('[AC-F1-09d#14] 页面指针和版本缓存都隔离 app_id 与 page_key', async () => {
  const mine = appId();
  const other = appId();
  const missing = appId();
  await seedPage(h, mine);
  await seedPage(h, other, { versions: [{ number: 1, sections: GRAY }] });
  await seedPage(h, mine, {
    key: 'custom:x',
    current: 1,
    versions: [{ number: 1, sections: [{ id: 'custom' }] }],
  });
  expect((await success(h.app, mine)).sections).toEqual(FULL);
  expect((await success(h.app, other)).sections).toEqual(GRAY);
  expect((await success(h.app, mine, 'custom:x')).sections).toEqual([{ id: 'custom' }]);
  await rejected(await read(h.app, missing), 30701);
  expect((await success(h.app, mine)).sections).toEqual(FULL);
});

it('[AC-F1-09d#15] 没有 DB 仍注册路由，每次 50001', async () => {
  const app = await h.start('api', null);
  expect(
    app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: '/v1/pages/:page_key' }),
  ).toBe(true);
  const id = appId();
  await rejected(await read(app, id), 50001);
  await rejected(await read(app, id), 50001);
});

it.each(['public', 'risk'] as const)(
  '[AC-F1-09d#20] %s 先读后，版本检查与风控共用同一份最低版本缓存',
  async (first) => {
    const id = appId();
    await seedPage(h, id);
    const restricted = await session(h, id, await registerDevice(h, id), 'deletion_only');
    await seed(
      db,
      row(id, { platform: 'ios', channel: 'appstore', min_supported_version: '1.0.0' }),
    );
    async function publicMinimum() {
      const response = await h.app.inject({
        method: 'GET',
        url: '/v1/app-versions/check',
        headers: { ...headers(id), 'x-channel': 'appstore' },
      });
      expect(response.statusCode).toBe(200);
      await validate(response, '/v1/app-versions/check');
      return response.json<{ data: { min_supported_version: string } }>().data
        .min_supported_version;
    }
    async function riskMinimum() {
      const response = await read(h.app, id, 'home', {
        ...restricted.headers,
        'x-channel': 'appstore',
      });
      await rejected(response, 10405);
      return response.json<{ data: { min_supported_version: string } }>().data
        .min_supported_version;
    }
    expect(await (first === 'public' ? publicMinimum() : riskMinimum())).toBe('1.0.0');
    await db
      .withSchema('app')
      .updateTable('app_versions')
      .set({ min_supported_version: '1.5.0' })
      .where('app_id', '=', id)
      .where('platform', '=', 'ios')
      .where('channel', '=', 'appstore')
      .execute();
    h.deps.clock.advanceMs(59_999);
    expect(await (first === 'public' ? riskMinimum() : publicMinimum())).toBe('1.0.0');
    h.deps.clock.advanceMs(1);
    expect(await publicMinimum()).toBe('1.5.0');
    expect(await riskMinimum()).toBe('1.5.0');
  },
);

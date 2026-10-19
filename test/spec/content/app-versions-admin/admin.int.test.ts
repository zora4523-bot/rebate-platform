import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import * as adminValidation from '../../../../apps/api/src/modules/content/application/app-version-admin-validation.ts';
import {
  audits,
  business,
  detail,
  factory,
  input,
  list,
  member,
  rejected,
  rows,
  save,
  saveOk,
  seedRow,
  setup,
  snapshot,
  stepUp,
  storeKeys,
  success,
  useHarness,
  type Page,
  type Save,
  type Version,
} from './kit.ts';
import { auditFailure, changeAfterPreRead } from './transactions.ts';

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02zc#1] 新建原样返回、主库一致、Clock 时间、UUIDv7；重发不重复保存', async () => {
  const f = await setup(h);
  const body = input();
  const saved = await saveOk(f);
  expect(saved).toEqual({
    ...business(body),
    platform: 'android',
    channel: 'official',
    row_version: 0,
    updated_at: f.clock.now().toISOString(),
  });
  const stored = await rows(h, f.appId);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ ...business(body), row_version: 0, app_id: f.appId });
  expect(stored[0]!.id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(new Date(stored[0]!.created_at).toISOString()).toBe(saved.updated_at);
  expect(new Date(stored[0]!.updated_at).toISOString()).toBe(saved.updated_at);
  expect(await success<Version>(await detail(f), 'detail')).toEqual(saved);
  const before = await snapshot(h, f.appId);
  await rejected(await save(f, body), 'save', 20902, { resource: 'app_version' });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02zc#2] 整行替换及原值保存均递增版本并写一次完整审计', async () => {
  const f = await setup(h);
  const first = await saveOk(f);
  const patch: Partial<Save> = {
    expected_row_version: 0,
    update_title: '',
    update_notes: '',
    recommended_version: null,
    store_listings: [...first.store_listings].reverse(),
  };
  const second = await saveOk(f, patch);
  const third = await saveOk(f, { ...patch, expected_row_version: 1 });
  expect(second.row_version).toBe(1);
  expect(third.row_version).toBe(2);
  expect(business(second)).toEqual(business(input(patch)));
  expect(business(third)).toEqual(business(second));
  const log = await audits(h, f.appId);
  expect(log).toHaveLength(3);
  expect(log[0]).toMatchObject({
    admin_id: f.actor.id,
    action: 'app_version_save',
    target: 'android/official',
    before: null,
  });
  for (const [index, value] of [first, second, third].entries()) {
    expect(log[index]!.after).toMatchObject({
      ...business(value),
      platform: 'android',
      channel: 'official',
      row_version: index,
      confirmed_stores: [],
    });
    if (index > 0)
      expect(log[index]!.before).toMatchObject({
        ...business(index === 1 ? first : second),
        row_version: index - 1,
      });
  }
  expect(new Date((await rows(h, f.appId))[0]!.created_at).toISOString()).toBe(first.updated_at);
  expect(third.updated_at).toBe(f.clock.now().toISOString());
});

it.each([
  [true, null],
  [true, 7],
  [false, 0],
] as const)('[AC-F1-02zc#3] CAS 有行=%s expected=%s 拒绝且无副作用', async (exists, expected) => {
  const f = await setup(h);
  if (exists) await seedRow(h, f.appId);
  const before = await snapshot(h, f.appId);
  await rejected(await save(f, input({ expected_row_version: expected })), 'save', 20902, {
    resource: 'app_version',
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([false, true])(
  '[AC-F1-02zc#4] 并发保存 existing=%s 恰一成功，输家 20902、只一条审计',
  async (exists) => {
    const f = await setup(h);
    if (exists) await seedRow(h, f.appId);
    const other = await member(h, f, ['content.app_version']);
    const expected = exists ? 0 : null;
    const replies = await Promise.all([
      save(f, input({ expected_row_version: expected, update_title: '甲' })),
      save(
        { ...f, token: other.token },
        input({ expected_row_version: expected, update_title: '乙' }),
      ),
    ]);
    expect(replies.map((r) => r.response.json().code).sort((a, b) => a - b)).toEqual([0, 20902]);
    const winner = await success<Version>(
      replies.find((r) => r.response.json().code === 0)!,
      'save',
    );
    await rejected(
      replies.find((r) => r.response.json().code !== 0)!,
      'save',
      20902,
      { resource: 'app_version' },
    );
    expect(await rows(h, f.appId)).toHaveLength(1);
    expect(winner.row_version).toBe(exists ? 1 : 0);
    expect((await rows(h, f.appId))[0]).toMatchObject(business(winner));
    expect(await audits(h, f.appId)).toHaveLength(1);
  },
);

it.each(['absent', 'null', '1.0.0'] as const)(
  '[AC-F1-02zc#5] 最低版本从 %s 提高必须 totp，成功后令牌失效',
  async (previous) => {
    const f = await setup(h);
    if (previous !== 'absent')
      await seedRow(h, f.appId, { min_supported_version: previous === 'null' ? null : previous });
    const body = input({
      min_supported_version: '1.1.0',
      expected_row_version: previous === 'absent' ? null : 0,
    });
    const before = await snapshot(h, f.appId);
    await rejected(await save(f, body), 'save', 10003, { tier: 'totp' });
    // expected cannot be used as a proxy for whether this is a raise.
    await rejected(await save(f, { ...body, expected_row_version: 99 }), 'save', 10003, {
      tier: 'totp',
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
    const token = await stepUp(f);
    const saved = await success<Version>(await save(f, body, token), 'save');
    expect(saved.min_supported_version).toBe('1.1.0');
    const after = await snapshot(h, f.appId);
    await rejected(
      await save(
        f,
        input({ min_supported_version: '1.2.0', expected_row_version: saved.row_version }),
        token,
      ),
      'save',
      10003,
      { tier: 'totp' },
    );
    expect(await snapshot(h, f.appId)).toEqual(after);
  },
);

it.each([
  { min_supported_version: '0.9.0' },
  { min_supported_version: null },
  { update_title: '仅文案', update_notes: '说明' },
  { latest_version: '0.5.0' },
  { recommended_version: '9.0.0' },
])('[AC-F1-02zc#6] 非提高保存无需动态码且不擅自修正版本顺序 %j', async (patch) => {
  const f = await setup(h);
  // Deliberately already below minimum: an implementation checking every save would reject.
  const listings = input().store_listings.map((row) => ({ ...row, listed_version: '0.0.0' }));
  await seedRow(h, f.appId, { min_supported_version: '1.0.0', store_listings: listings });
  const body = input({
    min_supported_version: '1.0.0',
    store_listings: listings,
    expected_row_version: 0,
    ...patch,
  });
  expect(business(await success<Version>(await save(f, body), 'save'))).toEqual(business(body));
  const reordered = await success<Version>(
    await save(f, { ...body, expected_row_version: 1, store_listings: [...listings].reverse() }),
    'save',
  );
  expect(reordered.store_listings).toEqual([...listings].reverse());
  expect(reordered.row_version).toBe(2);
  expect((await audits(h, f.appId)).at(-1)!.after).toMatchObject({ confirmed_stores: [] });
});

it.each([20001, 20902])('[AC-F1-02zc#7] 提高请求因 %s 被拒不消耗令牌、不写审计', async (code) => {
  const f = await setup(h);
  await seedRow(h, f.appId);
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  const invalid = input({
    min_supported_version: '2.0.0',
    expected_row_version: code === 20001 ? 0 : 99,
  });
  await rejected(
    await save(f, invalid, token),
    'save',
    code,
    code === 20001 ? { fields: ['min_supported_version'] } : { resource: 'app_version' },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  const good = await saveOk(f, { min_supported_version: '1.1.0', expected_row_version: 0 }, token);
  expect(good.row_version).toBe(1);
  expect(await audits(h, f.appId)).toHaveLength(1);
});

it('[AC-F1-02zc#8] 两店例全流程；只审计实际落后商店，额外确认忽略', async () => {
  const body = input({ min_supported_version: '1.1.0' });
  const keys = body.store_listings.map((row) => row.store);
  if (keys.length < 2) {
    const extra = keys.includes('store_fixture') ? 'store_fixture_b' : 'store_fixture';
    keys.push(extra);
    body.store_listings.push({ store: extra, listed_version: '1.1.0' });
  }
  // Inject only the table boundary; all validation, guard, SQL and audit remain real.
  const table = vi.spyOn(adminValidation, 'storeKeysFor').mockReturnValue(keys);
  try {
    const f = await setup(h);
    // Use configured keys; a synthetic second row keeps the two-store scenario meaningful even if only one store is registered.
    const [a, b] = body.store_listings.map((s) => s.store);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    body.default_store = a!;
    body.store_listings = body.store_listings.map((s) => ({ ...s, listed_version: '1.1.0' }));
    await success<Version>(await save(f, body, await stepUp(f)), 'save');
    const lowered = body.store_listings.map((s) => ({
      ...s,
      listed_version: s.store === a ? '1.0.0' : s.listed_version,
    }));
    const original = await snapshot(h, f.appId);
    await rejected(
      await save(f, { ...body, expected_row_version: 0, store_listings: lowered }),
      'save',
      20001,
      { fields: ['store_listings'] },
    );
    expect(await snapshot(h, f.appId)).toEqual(original);
    await success<Version>(
      await save(f, { ...body, default_store: b!, expected_row_version: 0 }),
      'save',
    );
    const switched = await snapshot(h, f.appId);
    const next = { ...body, default_store: b!, store_listings: lowered, expected_row_version: 1 };
    await rejected(await save(f, next), 'save', 20001, { fields: ['confirmed_stores'] });
    expect(await snapshot(h, f.appId)).toEqual(switched);
    const saved = await success<Version>(
      await save(f, { ...next, confirmed_stores: [b!, a!] }),
      'save',
    );
    expect(saved.min_supported_version).toBe('1.1.0');
    expect((await audits(h, f.appId)).at(-1)!.after).toMatchObject({ confirmed_stores: [a] });
    const beforeSwitchBack = await snapshot(h, f.appId);
    await rejected(
      await save(f, {
        ...next,
        default_store: a!,
        expected_row_version: saved.row_version,
        confirmed_stores: [a!],
      }),
      'save',
      20001,
      { fields: ['default_store'] },
    );
    expect(await snapshot(h, f.appId)).toEqual(beforeSwitchBack);
  } finally {
    table.mockRestore();
  }
});

it('[AC-F1-02zc#9] 单店先下调 min 再改登记都成功；清空或删掉默认店仍须核对', async () => {
  const f = await setup(h);
  const store = input().default_store;
  const single = { default_store: store, store_listings: [{ store, listed_version: '1.1.0' }] };
  await seedRow(h, f.appId, { ...single, min_supported_version: '1.1.0' });
  for (const listings of [[], [{ store, listed_version: null }]]) {
    await rejected(
      await save(
        f,
        input({
          ...single,
          min_supported_version: '1.1.0',
          expected_row_version: 0,
          store_listings: listings,
        }),
      ),
      'save',
      20001,
      { fields: ['store_listings'] },
    );
  }
  await saveOk(f, { ...single, min_supported_version: '1.0.0', expected_row_version: 0 });
  const saved = await saveOk(f, {
    ...single,
    min_supported_version: '1.0.0',
    expected_row_version: 1,
    store_listings: [{ store, listed_version: '1.0.0' }],
  });
  expect(saved.row_version).toBe(2);
  expect(await audits(h, f.appId)).toHaveLength(2);
});

it('[AC-F1-02zc#10] 商店核对用当前库值与保存后的 min，不能复用旧请求判断', async () => {
  const f = await setup(h);
  const original = input({ min_supported_version: '1.1.0' });
  await seedRow(h, f.appId, original);
  // Concurrent operator lowered the minimum without touching the row version (fixture corruption).
  // Replaying the original full row now raises the minimum and must recheck its low default.
  const low = original.store_listings.map((s) => ({ ...s, listed_version: '1.0.0' }));
  await h.db
    .updateTable('app_versions')
    .set({ min_supported_version: '1.0.0', store_listings: sql`${JSON.stringify(low)}::jsonb` })
    .where('app_id', '=', f.appId)
    .execute();
  const before = await snapshot(h, f.appId);
  await rejected(
    await save(f, { ...original, store_listings: low, expected_row_version: 0 }, await stepUp(f)),
    'save',
    20001,
    { fields: ['min_supported_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  ['h5', 'official', {}, 'platform'],
  ['admin', 'official', {}, 'platform'],
  ['ios', 'official', {}, 'channel'],
  ['android', 'official', { store_url: 'http://store.test/a' }, 'store_url'],
  ['android', 'official', { store_url: 'javascript:alert(1)' }, 'store_url'],
  ['android', 'official', { update_title: '字'.repeat(101) }, 'update_title'],
  ['android', 'official', { update_notes: '字'.repeat(2001) }, 'update_notes'],
] as const)(
  '[AC-F1-02zc#11] 字段校验 %s/%s %j -> %s 无副作用',
  async (platform, channel, patch, field) => {
    const f = await setup(h);
    await rejected(await save(f, input(patch), undefined, platform, channel), 'save', 20001, {
      fields: [field],
    });
    expect(await snapshot(h, f.appId)).toEqual({ rows: [], audits: [] });
  },
);

it('[AC-F1-02zc#12] 重复商店拒绝；空表只校格式并告警', async () => {
  const f = await setup(h);
  const body = input();
  await rejected(
    await save(f, { ...body, store_listings: [body.store_listings[0], body.store_listings[0]] }),
    'save',
    20001,
    { fields: ['store_listings'] },
  );
  expect(await snapshot(h, f.appId)).toEqual({ rows: [], audits: [] });
  await saveOk(f);
  if (storeKeys().length === 0)
    expect(
      f.lines
        .map((line) => JSON.parse(line) as { level: number })
        .some((line) => line.level === 40),
    ).toBe(true);
  else {
    let unknown = 'unregistered';
    while (storeKeys().includes(unknown)) unknown += '_x';
    await rejected(
      await save(f, input({ expected_row_version: 0, confirmed_stores: [unknown] })),
      'save',
      20001,
      { fields: ['confirmed_stores'] },
    );
  }
});

it('[AC-F1-02zc#13] 三操作需权限；只读无需动态码、不审计；身份只认 actor', async () => {
  const f = await setup(h);
  await seedRow(h, f.appId);
  const denied = { ...f, ...(await member(h, f, [])) };
  const before = await snapshot(h, f.appId);
  for (const [op, sent] of [
    ['list', await list(denied)],
    ['detail', await detail(denied)],
    ['save', await save(denied, input({ expected_row_version: 0 }))],
  ] as const) {
    await rejected(sent, op, 10403, { reason: 'admin_permission_denied' });
  }
  const allowed = { ...f, ...(await member(h, f, ['content.app_version'])) };
  expect((await success<Page>(await list(allowed), 'list')).items).toHaveLength(1);
  expect((await success<Version>(await detail(allowed), 'detail')).row_version).toBe(0);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02zc#14] 列表含 h5/admin，按端渠道排序；跨 app 隔离且无行 30701', async () => {
  const f = await setup(h);
  const other = `other_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await seedRow(h, other, { update_title: '他人数据' }, 'ios', 'appstore');
  for (const [platform, channel] of [
    ['h5', 'official'],
    ['android', 'official'],
    ['android', 'huawei'],
    ['admin', 'official'],
  ]) {
    await seedRow(h, f.appId, {}, platform!, channel!);
  }
  const page = await success<Page>(await list(f), 'list');
  expect(page.items.map((row) => `${row.platform}/${row.channel}`)).toEqual([
    'admin/official',
    'android/huawei',
    'android/official',
    'h5/official',
  ]);
  await rejected(await detail(f, 'ios', 'appstore'), 'detail', 30701);
  expect((await success<Version>(await detail(f, 'h5'), 'detail')).platform).toBe('h5');
  expect(await audits(h, f.appId)).toEqual([]);
  const foreignBefore = await snapshot(h, other);
  await saveOk(f, { expected_row_version: 0, update_title: '自己的修改' });
  expect(await snapshot(h, other)).toEqual(foreignBefore);
});

it.each(['channel', 'store_listings'] as const)(
  '[AC-F1-02zc#15] 脏行 %s 列表跳过并 warn，单取 50001',
  async (field) => {
    const f = await setup(h);
    await seedRow(h, f.appId, {}, 'h5');
    await seedRow(h, f.appId);
    await h.db
      .updateTable('app_versions')
      .set(
        field === 'channel'
          ? { channel: 'unknown_channel' }
          : { store_listings: sql`'[{}]'::jsonb` },
      )
      .where('app_id', '=', f.appId)
      .where('platform', '=', 'android')
      .execute();
    const page = await success<Page>(await list(f), 'list');
    expect(page.items.map((row) => row.platform)).toEqual(['h5']);
    expect(
      f.lines
        .map((line) => JSON.parse(line) as { level: number; msg: string })
        .some((line) => line.level === 40 && line.msg === 'content_app_version_invalid'),
    ).toBe(true);
    if (field === 'store_listings') await rejected(await detail(f), 'detail', 50001);
    expect(await audits(h, f.appId)).toEqual([]);
  },
);

it('[AC-F1-02zc#16] 后台保存后新 app 的 api check 立即读到；既有缓存下次 TTL 刷新生效', async () => {
  const f = await setup(h);
  const first = await saveOk(f);
  const api = await (await factory())('api', f.overrides);
  h.apps.push(api);
  await api.init();
  async function check() {
    const trace = randomUUID();
    const response = await api.inject({
      method: 'GET',
      url: '/v1/app-versions/check',
      headers: {
        'x-trace-id': trace,
        'x-app-id': f.appId,
        'x-platform': 'android',
        'x-channel': 'official',
        'x-app-version': '1.0.0',
        'x-device-id': randomUUID(),
      },
    });
    return success<Record<string, unknown>>({ response, trace }, 'check');
  }
  const { store_listings, ...fields } = business(first);
  expect(await check()).toEqual({ ...fields, stores: store_listings });
  await saveOk(f, { latest_version: '2.0.0', expected_row_version: 0 });
  f.clock.advanceMs(60_000);
  expect(await check()).toMatchObject({ latest_version: '2.0.0' });
});

it.each([false, true])('[AC-F1-02zc#17] 审计失败时整笔回滚 existing=%s', async (existing) => {
  const f = await setup(h);
  if (existing) await seedRow(h, f.appId);
  const before = await snapshot(h, f.appId);
  const sent = await auditFailure(h, f, input({ expected_row_version: existing ? 0 : null }));
  await rejected(sent, 'save', 50001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([false, true])(
  '[AC-F1-02zc#18] 预读与锁定之间变化 existing=%s，即使 expected 匹配也必须 20902',
  async (existing) => {
    const f = await setup(h);
    if (existing) await seedRow(h, f.appId, { min_supported_version: '1.1.0' });
    const sent = await changeAfterPreRead(h, f, existing);
    await rejected(sent, 'save', 20902, { resource: 'app_version' });
    expect(await audits(h, f.appId)).toEqual([]);
    const current = await rows(h, f.appId);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      min_supported_version: null,
      row_version: existing ? 1 : 0,
      update_title: '并发变更',
    });
  },
);

it('[AC-F1-02zc#27] 非空表非法确认键经 HTTP 拒绝；权限与动态码先于业务校验', async () => {
  const body = input();
  const keys = body.store_listings.map((row) => row.store);
  let unknown = 'unregistered';
  while (keys.includes(unknown)) unknown += '_x';
  const table = vi.spyOn(adminValidation, 'storeKeysFor').mockReturnValue(keys);
  try {
    const f = await setup(h);
    const denied = { ...f, ...(await member(h, f, [])) };
    const invalid = { ...body, confirmed_stores: [unknown] };
    await rejected(await save(denied, invalid), 'save', 10403, {
      reason: 'admin_permission_denied',
    });
    await rejected(await save(f, { ...invalid, min_supported_version: '1.0.0' }), 'save', 10003, {
      tier: 'totp',
    });
    await rejected(await save(f, invalid), 'save', 20001, { fields: ['confirmed_stores'] });
    await rejected(
      await save(denied, { ...invalid, update_title: '字'.repeat(101) }),
      'save',
      20001,
      { fields: ['update_title'] },
    );
    expect(await snapshot(h, f.appId)).toEqual({ rows: [], audits: [] });
    expect((await success<Version>(await save(f, body), 'save')).row_version).toBe(0);
  } finally {
    table.mockRestore();
  }
});

it('[AC-F1-02zc#28] 实际确认按 store_listings 顺序入审计，清空登记要逐家确认', async () => {
  const body = input({ min_supported_version: '1.0.0' });
  const keys = body.store_listings.map((row) => row.store);
  for (let n = 0; keys.length < 3; n += 1) {
    const key = `store_fixture_${String(n)}`;
    if (!keys.includes(key)) keys.push(key);
  }
  const [a, b, main] = keys;
  body.default_store = main!;
  body.store_listings = keys.map((store) => ({ store, listed_version: '1.2.0' }));
  const table = vi.spyOn(adminValidation, 'storeKeysFor').mockReturnValue(keys);
  try {
    const f = await setup(h);
    await success<Version>(await save(f, body, await stepUp(f)), 'save');
    const next = {
      ...body,
      expected_row_version: 0,
      store_listings: body.store_listings.map((row) =>
        row.store === a || row.store === b ? { ...row, listed_version: null } : row,
      ),
      confirmed_stores: [a!],
    };
    const before = await snapshot(h, f.appId);
    await rejected(await save(f, next), 'save', 20001, { fields: ['confirmed_stores'] });
    expect(await snapshot(h, f.appId)).toEqual(before);
    await success<Version>(await save(f, { ...next, confirmed_stores: [b!, main!, a!] }), 'save');
    expect((await audits(h, f.appId)).at(-1)!.after).toMatchObject({ confirmed_stores: [a, b] });
  } finally {
    table.mockRestore();
  }
});

it('[AC-F1-02zc#29] 请求头伪造 app_id 不能读取或修改其他 app', async () => {
  const f = await setup(h);
  const other = `other_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await seedRow(h, other, { update_title: '他人记录' });
  const before = await snapshot(h, other);
  const trace = randomUUID();
  const response = await f.app.inject({
    method: 'PUT',
    url: '/admin/v1/app-versions/android/official',
    headers: {
      authorization: `Bearer ${f.token}`,
      'x-trace-id': trace,
      'x-app-id': other,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(input()),
    remoteAddress: '127.0.0.1',
  });
  expect((await success<Version>({ response, trace }, 'save')).row_version).toBe(0);
  expect(await rows(h, f.appId)).toHaveLength(1);
  expect(await snapshot(h, other)).toEqual(before);
});

import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { factory, NOW, signedIn, useHarness } from '../auth/kit.ts';
import {
  CREATED,
  detail,
  expectBoth,
  expectNoSensitive,
  expectView,
  grant,
  page,
  rejected,
  seed,
  setup,
  SUPER,
  validate,
} from './kit.ts';

// HTTP acceptance, task §9 rulings. No application factory/stub is needed: the existing
// list probe returns an empty data object; the missing detail returns 404. Both must fail
// an assertion, before any indexing of response data. All database access runs in containers.
const h = useHarness();

it('[AC-F1-06m#1] 超管默认读取第一页、每页 20 条，列表与详情字段完整一致', async () => {
  const f = await setup(h);
  const a = await seed(h, f.appId);
  const result = await page(f);
  expect(result).toMatchObject({ page: 1, page_size: 20, total: 2 });
  expect(result.items.map((item) => item.admin_id)).toEqual([f.actor.id, a.id]);
  expectView(result.items[0]!, f.actor.expected);
  expectView(result.items[1]!, a.expected);
  expectView(await detail(f, a.id), a.expected);
});

it('[AC-F1-06m#2] 勾选全部权限和伪造账号管理权限也不能让普通账号读取列表或详情', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  await grant(h, ordinary, f.actor, [...admin_permission, 'admins', 'admin.manage']);
  const session = await signedIn(f, ordinary);
  for (const url of [SUPER, `${SUPER}/${f.actor.id}`, `${SUPER}/${ordinary.id}`]) {
    await rejected(
      await f.read(session.admin_token, url),
      10403,
      { reason: 'admin_permission_denied' },
      url !== SUPER,
    );
  }
  // The same resource is accessible to the super admin: also prevents the old probe
  // (which already enforces super auth) from making this rule prematurely green.
  expect((await page(f)).items.map((item) => item.admin_id)).toContain(ordinary.id);
});

it.each([
  ['page=0', 'page'],
  ['page=-1', 'page'],
  ['page=1.5', 'page'],
  ['page=abc', 'page'],
  ['page_size=0', 'page_size'],
  ['page_size=-1', 'page_size'],
  ['page_size=201', 'page_size'],
  ['page_size=1.5', 'page_size'],
  ['page_size=abc', 'page_size'],
])('[AC-F1-06m#3] 分页参数 %s 返回 20001 并指出 %s', async (query, field) => {
  const f = await setup(h);
  await rejected(await f.read(f.token, `${SUPER}?${query}`), 20001, { fields: [field] });
  expect((await page(f)).total).toBe(1);
});

it('[AC-F1-06m#4] 分页按 created_at 再按 id 升序，total 含停用账号且不随页码变化', async () => {
  const f = await setup(h);
  // Reverse insertion order and misleading usernames distinguish SQL order from insertion/name.
  const later = await seed(h, f.appId, { createdAt: '2026-10-02T00:00:00.000Z' });
  const high = await seed(h, f.appId, {
    id: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    status: 'disabled',
  });
  const low = await seed(h, f.appId, { id: '00000000-0000-4000-8000-000000000001' });
  const expected = [f.actor.id, low.id, high.id, later.id];
  for (const [number, ids] of [
    [1, expected.slice(0, 2)],
    [2, expected.slice(2)],
    [3, []],
  ] as const) {
    const result = await page(f, `?page=${number}&page_size=2`);
    expect(result).toMatchObject({ page: number, page_size: 2, total: 4 });
    expect(result.items.map((item) => item.admin_id)).toEqual(ids);
    expect(await page(f, `?page=${number}&page_size=2`)).toEqual(result);
  }
  expectView(await detail(f, high.id), high.expected);
});

it('[AC-F1-06m#5] page_size 允许 1 与 200，默认 20 真正截断，最后一页保留 total', async () => {
  const f = await setup(h);
  // 201 accounts including the actor: exercise both sides of the maximum page boundary.
  const ids: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const a = await seed(h, f.appId);
    ids.push(a.id);
  }
  const ordered = [f.actor.id, ...ids.sort()];
  const defaults = await page(f);
  expect(defaults).toMatchObject({ page: 1, page_size: 20, total: 201 });
  expect(defaults.items.map((item) => item.admin_id)).toEqual(ordered.slice(0, 20));
  const one = await page(f, '?page=2&page_size=1');
  expect(one).toMatchObject({ page: 2, page_size: 1, total: 201 });
  expect(one.items.map((item) => item.admin_id)).toEqual(ordered.slice(1, 2));
  const max = await page(f, '?page_size=200');
  expect(max).toMatchObject({ page: 1, page_size: 200, total: 201 });
  expect(max.items.map((item) => item.admin_id)).toEqual(ordered.slice(0, 200));
  const last = await page(f, '?page=2&page_size=200');
  expect(last).toMatchObject({ page: 2, page_size: 200, total: 201 });
  expect(last.items.map((item) => item.admin_id)).toEqual(ordered.slice(200));
  const defaultSize = await page(f, '?page=2');
  expect(defaultSize).toMatchObject({ page: 2, page_size: 20, total: 201 });
  expect(defaultSize.items.map((item) => item.admin_id)).toEqual(ordered.slice(20, 40));
});

it('[AC-F1-06m#6] 只返回令牌所属 app 的账号与 total，他 app 的详情视同不存在', async () => {
  const f = await setup(h);
  const own = await seed(h, f.appId, { status: 'disabled' });
  const foreign = await seed(h, `other-${randomUUID()}`, { isSuper: true });
  const result = await page(f);
  expect(result.total).toBe(2);
  expect(result.items.map((item) => item.admin_id)).toEqual([f.actor.id, own.id]);
  await rejected(
    await f.read(f.token, `${SUPER}/${foreign.id}`),
    20001,
    { fields: ['admin_id'] },
    true,
  );
  // Reverse direction verifies that the tenant is derived from the authenticated principal.
  const otherSession = await signedIn(f, foreign);
  const other = { ...f, token: otherSession.admin_token };
  expect((await page(other)).items.map((item) => item.admin_id)).toEqual([foreign.id]);
  expect((await page(other)).total).toBe(1);
  await rejected(
    await other.read(other.token, `${SUPER}/${own.id}`),
    20001,
    { fields: ['admin_id'] },
    true,
  );
});

it('[AC-F1-06m#7] 列表和详情只暴露脱敏手机号，不泄露密码、哈希、动态码密钥或密文', async () => {
  const f = await setup(h);
  const phone = '13812345678';
  const a = await seed(h, f.appId, { phone, status: 'disabled' });
  const stored = await h.db
    .selectFrom('admin_users')
    .selectAll()
    .where('id', '=', a.id)
    .executeTakeFirstOrThrow();
  for (const url of [SUPER, `${SUPER}/${a.id}`]) {
    const response = await f.read(f.token, url);
    expect(response.statusCode).toBe(200);
    await validate(response, url !== SUPER);
    expectNoSensitive(response.json(), [
      phone,
      h.password,
      h.passwordHash,
      a.secret,
      stored.verify_phone_cipher!.toString(),
      stored.totp_secret_cipher!.toString(),
      stored.verify_phone_hmac!,
    ]);
  }
  await expectBoth(f, a, { ...a.expected, verify_phone_masked: '138****5678' });
});

it('[AC-F1-06m#8] 未登记手机号返回 null，绑定标志只由 totp_bound_at 决定', async () => {
  const f = await setup(h);
  // A pending secret is deliberately present, as in the real enrollment flow.
  const pending = await seed(h, f.appId, { bound: false });
  const bound = await seed(h, f.appId, { bound: true });
  await expectBoth(f, pending);
  await expectBoth(f, bound);
});

it('[AC-F1-06m#9] 超管权限恒为空数组，即使数据库有勾选项', async () => {
  const f = await setup(h);
  await grant(h, f.actor, f.actor, ['fund.adjust', 'user.list', 'obsolete.permission']);
  await expectBoth(f, f.actor);
});

it('[AC-F1-06m#10] 普通账号只返回已勾选且仍在枚举中的权限，并按枚举顺序排列', async () => {
  const f = await setup(h);
  const a = await seed(h, f.appId);
  const unrelated = await seed(h, f.appId);
  await grant(h, unrelated, f.actor, ['export']);
  await grant(h, a, f.actor, [
    'fund.adjust',
    'ticket.handle',
    'audit.view_all',
    'user.list',
    'fund.view',
    'unknown.permission',
  ]);
  await expectBoth(f, a, {
    ...a.expected,
    permissions: ['user.list', 'fund.view', 'audit.view_all', 'fund.adjust'],
  });
  await expectBoth(f, unrelated, { ...unrelated.expected, permissions: ['export'] });
});

it('[AC-F1-06m#11] 锁定状态按注入时钟计算，到期瞬间及过期都返回 null，读取不改库', async () => {
  const f = await setup(h);
  const future = '2026-10-09T02:01:00.000Z';
  const a = await seed(h, f.appId, { lockedUntil: future });
  const expired = await seed(h, f.appId, { lockedUntil: '2026-10-09T01:59:59.000Z' });
  const equal = await seed(h, f.appId, { lockedUntil: NOW });
  await expectBoth(f, a);
  await expectBoth(f, expired, { ...expired.expected, locked_until: null });
  await expectBoth(f, equal, { ...equal.expected, locked_until: null });
  const before = await h.db
    .selectFrom('admin_users')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
  f.clock.set(future);
  await expectBoth(f, a, { ...a.expected, locked_until: null });
  f.clock.advanceMs(1);
  await expectBoth(f, a, { ...a.expected, locked_until: null });
  expect(
    await h.db
      .selectFrom('admin_users')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  ).toEqual(before);
});

it.each(['unknown', 'not-a-uuid', '123', '00000000-0000-4000-8000-zzzzzzzzzzzz'])(
  '[AC-F1-06m#12] 未知或非法 admin_id（%s）返回 20001 fields=[admin_id]',
  async (id) => {
    const f = await setup(h);
    const requested = id === 'unknown' ? randomUUID() : id;
    await rejected(
      await f.read(f.token, `${SUPER}/${requested}`),
      20001,
      { fields: ['admin_id'] },
      true,
    );
  },
);

it('[AC-F1-06m#13] 配置独立 dbRead 时列表、计数、详情仍只查询 couli_app 主库', async () => {
  const f = await setup(h);
  const a = await seed(h, f.appId, { phone: '13912340000', createdAt: CREATED });
  const replicaQuery = vi.fn();
  // A fully working Kysely handle, instrumented at its query boundary: no incomplete mock
  // or deliberately thrown error can masquerade as a legitimate red failure.
  const dbRead = h.db.withPlugin({
    transformQuery(args) {
      replicaQuery();
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db: h.db, dbRead, close: async () => undefined },
  });
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  const master = {
    ...f,
    read: (token: string, url = SUPER) =>
      app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: '127.0.0.1',
      }),
  };
  const result = await page(master);
  expect(result.total).toBe(2);
  expectView(result.items[1]!, { ...a.expected, verify_phone_masked: '139****0000' });
  expectView(await detail(master, a.id), { ...a.expected, verify_phone_masked: '139****0000' });
  expect(replicaQuery).not.toHaveBeenCalled();
});

it('[AC-F1-06m#14] 列表与详情读取前后，账号、权限和审计记录均不改变', async () => {
  const f = await setup(h);
  const a = await seed(h, f.appId, { status: 'disabled' });
  await grant(h, a, f.actor, ['fund.view']);
  const snapshot = async () => ({
    accounts: await h.db
      .selectFrom('admin_users')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    permissions: await h.db
      .selectFrom('admin_permissions')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    audit: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  });
  const before = await snapshot();
  await expectBoth(f, a, { ...a.expected, permissions: ['fund.view'] });
  expect(await snapshot()).toEqual(before);
});

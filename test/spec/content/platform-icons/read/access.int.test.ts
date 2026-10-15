import { expect, it, vi } from 'vitest';
import { grant, seed } from '../../../admin/accounts/kit.ts';
import { factory, signedIn, useHarness } from '../../../admin/auth/kit.ts';
import { guardOf } from '../../../admin/guard-mount/kit.ts';
import { HISTORY, LIST, history, icon, list, rejected, setup, version } from './kit.ts';

const h = useHarness();

it.each([
  ['page=0', ['page']],
  ['page=-1', ['page']],
  ['page=1.5', ['page']],
  ['page=no', ['page']],
  ['page_size=0', ['page_size']],
  ['page_size=-1', ['page_size']],
  ['page_size=201', ['page_size']],
  ['page_size=1.5', ['page_size']],
  ['page_size=no', ['page_size']],
  ['page=0&page_size=201', ['page', 'page_size']],
])('[AC-F1-06w#8] 非法分页 %s 返回 20001，fields 指出所有非法参数', async (query, fields) => {
  const f = await setup(h);
  const response = await f.read(f.token, `${LIST}/jd/versions?${query}`);
  await rejected(response, HISTORY, 20001);
  const data = response.json<{ data: { fields: string[] } }>().data;
  expect(data).toEqual({ fields: expect.any(Array) });
  expect([...data.fields].sort()).toEqual([...fields].sort());
});

it.each(['unknown', 'TAOBAO', 'wechat-pay', 'constructor'])(
  '[AC-F1-06w#9] 枚举外的键 %s 返回 20001 fields=[key]',
  async (key) => {
    const f = await setup(h);
    await rejected(await f.read(f.token, `${LIST}/${key}/versions`), HISTORY, 20001, {
      fields: ['key'],
    });
  },
);

it('[AC-F1-06w#10] 两条路由未登录均返回 10001，登录后的超管无需勾权限或二次验证', async () => {
  const f = await setup(h);
  // A positive request prevents an existing global auth hook from making a missing route pass.
  expect(await list(f)).toHaveLength(8);
  expect(await history(f, 'jd')).toMatchObject({ total: 0 });
  for (const [url, path] of [
    [LIST, LIST],
    [`${LIST}/jd/versions`, HISTORY],
  ]) {
    await rejected(
      await f.app.inject({ method: 'GET', url: url!, remoteAddress: '127.0.0.1' }),
      path!,
      10001,
    );
  }
});

it('[AC-F1-06w#11] 普通账号无权限或仅有无关权限被拒，勾 content.platform_icon 后无需 step-up', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  await grant(h, ordinary, f.actor, ['user.list']);
  const session = await signedIn(f, ordinary);
  const reader = { ...f, token: session.admin_token };
  for (const [url, path] of [
    [LIST, LIST],
    [`${LIST}/jd/versions`, HISTORY],
  ]) {
    await rejected(await f.read(reader.token, url), path!, 10403, {
      reason: 'admin_permission_denied',
    });
  }
  await grant(h, ordinary, f.actor, ['content.platform_icon']);
  expect(await list(reader)).toHaveLength(8);
  expect(await history(reader, 'jd')).toMatchObject({ items: [], total: 0 });
});

it('[AC-F1-06w#12] 两个处理函数调用平台守卫，权限通过之前不查询标识表', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  const session = await signedIn(f, ordinary);
  const statements: string[] = [];
  const db = h.db.withPlugin({
    transformQuery(args) {
      statements.push(JSON.stringify(args.node));
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
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  const guard = await guardOf(app);
  const run = vi.spyOn(guard, 'run'); // Observe the real guard; never replace its decision.
  try {
    for (const [url, path] of [
      [LIST, LIST],
      [`${LIST}/jd/versions`, HISTORY],
    ]) {
      run.mockClear();
      statements.length = 0;
      const response = await app.inject({
        method: 'GET',
        url: url!,
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${session.admin_token}` },
      });
      await rejected(response, path!, 10403, { reason: 'admin_permission_denied' });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        request: expect.any(Object),
        permission: 'content.platform_icon',
      });
      expect(
        statements.filter((text) =>
          /platform_icons|platform_icon_versions|platform_icon_uploads/.test(text),
        ),
      ).toEqual([]);
    }
  } finally {
    run.mockRestore();
  }
});

it('[AC-F1-06w#13] 两条路由只挂在 admin 入口，api 和 stream 不挂', async () => {
  const f = await setup(h);
  const paths = [LIST, `${LIST}/:key/versions`];
  for (const path of paths)
    expect(f.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: path })).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const app = await (await factory())(entry, f.overrides);
    h.apps.push(app);
    await expect(app.init()).resolves.toBeDefined();
    for (const path of paths)
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: path })).toBe(false);
  }
});

it('[AC-F1-06w#14] 列表与历史只读主库，忽略 dbRead', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, { ever_published: true });
  await icon(h, f.actor, 'jd', 1, 2);
  const replicaQuery = vi.fn();
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
  const reader = {
    token: f.token,
    read: (token: string, url = LIST) =>
      app.inject({
        method: 'GET',
        url,
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` },
      }),
  };
  expect((await list(reader)).find((item) => item.key === 'jd')).toMatchObject({
    current_version: 1,
    latest_version: 1,
  });
  expect(await history(reader, 'jd')).toMatchObject({ total: 1 });
  expect(replicaQuery).not.toHaveBeenCalled();
});

it('[AC-F1-06w#15] 未配置媒体地址时可启动和读内置态，含版本响应按请求返回 50001', async () => {
  const f = await setup(h);
  // Isolate the staging/prod media configuration result without requiring production keys
  // or production adapters. All other configuration and backends remain the test fixture's.
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    config: { ...f.overrides.config, mediaPublicBaseUrl: undefined },
  });
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  const reader = {
    token: f.token,
    read: (token: string, url = LIST) =>
      app.inject({
        method: 'GET',
        url,
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` },
      }),
  };
  expect(await list(reader)).toHaveLength(8);
  expect(await history(reader, 'jd')).toMatchObject({ items: [], total: 0 });
  await version(h, f.actor, 'jd', 1);
  await icon(h, f.actor, 'jd', null);
  // A saved draft has no current object in the list, so it requires no URL there.
  expect((await list(reader)).find((item) => item.key === 'jd')).toMatchObject({
    current: null,
    latest_version: 1,
  });
  await rejected(await reader.read(f.token, `${LIST}/jd/versions`), HISTORY, 50001);
  await h.db
    .updateTable('platform_icons')
    .set({ current_version: 1, revision: 1 })
    .where('app_id', '=', f.appId)
    .where('key', '=', 'jd')
    .execute();
  await rejected(await reader.read(f.token, LIST), LIST, 50001);
  // Failure is scoped to the response needing media; another empty key remains readable.
  expect(await history(reader, 'wechat')).toMatchObject({ items: [], total: 0 });
});

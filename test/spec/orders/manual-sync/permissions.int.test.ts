import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  DENIED,
  LIMITS,
  MIN,
  NOW_MS,
  PATH,
  iso,
  mounted,
  ok,
  rejected,
  seedRequest,
  setup,
  unionAccount,
  type Created,
  type Page,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const WINDOW = { platform: 'pdd', from: iso(NOW_MS - 90 * MIN), to: iso(NOW_MS - 70 * MIN) };

async function deniedEverywhere(s: Scenario, headers: Record<string, string> = {}) {
  await rejected(await s.post(WINDOW, headers), 'create', 10403, DENIED);
  await rejected(await s.list({}, headers), 'list', 10403, DENIED);
  await rejected(await s.limits(headers), 'limits', 10403, DENIED);
  expect(await s.rows()).toEqual([]);
  expect(s.jobs()).toEqual([]);
}

it.each([{ grants: [] }, { grants: ['user.lookup'] }, { grants: ['export', 'user.list'] }])(
  '[AC-B1-09i#31] 没有 order.view（权限 %j）时三个接口都 10403，不建请求不投递',
  async ({ grants }) => {
    const s = await setup(h, { grants });
    await unionAccount(s, 'pdd');
    await deniedEverywhere(s);
  },
);

it.each([
  { grants: ['order.view'], isSuper: false },
  { grants: [], isSuper: true },
] as const)('[AC-B1-09i#32] order.view 或超管可用三个接口（%j）', async (options) => {
  const s = await setup(h, options);
  await unionAccount(s, 'pdd');
  const created = await ok<Created>(await s.post(WINDOW), 'create');
  expect(created.reused).toBe(false);
  expect((await ok<Page>(await s.list(), 'list')).items.map((i) => i.sync_id)).toEqual([
    created.sync_id,
  ]);
  await ok(await s.limits(), 'limits');
});

it('[AC-B1-09i#33] 撤销 order.view 后下一次请求立即 10403', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  await ok(await s.limits(), 'limits');
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .execute();
  await deniedEverywhere(s);
});

it('[AC-B1-09i#34] 三个接口都必须登录后台；伪造令牌 10001', async () => {
  const s = await setup(h);
  for (const authorization of [undefined, 'Bearer forged']) {
    const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
    const create = await s.f.app.inject({
      method: 'POST',
      url: PATH,
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(WINDOW),
    });
    await rejected(create, 'create', 10001);
    for (const [url, op] of [
      [PATH, 'list'],
      [LIMITS, 'limits'],
    ] as const) {
      await rejected(
        await s.f.app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers }),
        op,
        10001,
      );
    }
  }
  expect(await s.rows()).toEqual([]);
  expect(s.jobs()).toEqual([]);
});

it('[AC-B1-09i#35] 应用与申请人取自令牌：伪造身份头不改变落库应用、不越权读别的应用', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const other = await setup(h);
  const foreign = await seedRequest(other);
  const forged = {
    'x-app-id': other.appId,
    'x-admin-id': randomUUID(),
    'x-is-super': 'true',
    'x-permissions': 'order.view',
  };
  const created = await ok<Created>(await s.post(WINDOW, forged), 'create');
  const [row] = await s.rows();
  expect(row).toMatchObject({ id: created.sync_id, app_id: s.appId, requested_by: s.a.id });
  expect((await other.rows()).map((r) => r.id)).toEqual([foreign.id]);
  const page = await ok<Page>(await s.list({}, forged), 'list');
  expect(page.items.map((i) => i.sync_id)).toEqual([created.sync_id]);
  expect(page.total).toBe(1);
  const none = await setup(h, { grants: [] });
  await deniedEverywhere(none, forged);
});

it('[AC-B1-09i#36] 三个接口只在 admin 入口注册', async () => {
  const s = await setup(h);
  expect(mounted(s.f)).toEqual([true, true, true]);
  for (const entry of ['api', 'stream'] as const) {
    expect(mounted(await fixture(h, { entry }))).toEqual([false, false, false]);
  }
});

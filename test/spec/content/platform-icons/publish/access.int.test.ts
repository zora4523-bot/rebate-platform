import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { grant, seed } from '../../../admin/accounts/kit.ts';
import { factory, signedIn, useHarness } from '../../../admin/auth/kit.ts';
import { guardOf } from '../../../admin/guard-mount/kit.ts';
import {
  hasRoute,
  icon,
  mark,
  OPERATIONS,
  REGISTERED,
  rejected,
  saved,
  setup,
  snapshot,
  SOURCE,
  success,
  version,
  write,
  type Operation,
} from './kit.ts';

const h = useHarness();
const bodies = {
  source: { expected_revision: 1, source_url: SOURCE },
  publish: { expected_revision: 0, version: 1 },
  restore: { expected_revision: 1 },
};

it.each(OPERATIONS)(
  '[AC-F1-06y#15] %s 未登录 10001、无权限 10403，拒绝前不访问标识表；授权后无需 step-up 或幂等键',
  async (op) => {
    const f = await setup(h);
    await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: op === 'restore' });
    if (op === 'restore') await icon(h, f.actor, 'jd', 1, 1);
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
    await app.init();
    const caller = { ...f, app, token: session.admin_token };
    const before = await snapshot(h, f.appId);
    await rejected(await write(caller, op, bodies[op], 'jd', 1, null), op, 10001);
    const guard = await guardOf(app);
    const run = vi.spyOn(guard, 'run');
    try {
      for (const unrelated of [false, true]) {
        if (unrelated) await grant(h, ordinary, f.actor, ['user.list']);
        run.mockClear();
        statements.length = 0;
        await rejected(await write(caller, op, bodies[op]), op, 10403, {
          reason: 'admin_permission_denied',
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ permission: 'content.platform_icon' });
        expect(
          statements.filter((s) =>
            /platform_icons|platform_icon_versions|platform_icon_uploads/.test(s),
          ),
        ).toEqual([]);
      }
      expect(await snapshot(h, f.appId)).toEqual(before);
      await grant(h, ordinary, f.actor, ['content.platform_icon']);
      await success(await write(caller, op, bodies[op]), op);
      expect(await mark(h, f.appId)).toMatchObject({
        updated_by: ordinary.username,
        updated_by_admin_id: ordinary.id,
      });
    } finally {
      run.mockRestore();
    }
  },
);

it.each(OPERATIONS)('[AC-F1-06y#16] %s 枚举外 key 返回 20001 [key]，不写库', async (op) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  for (const key of ['unknown', 'TAOBAO', 'wechat-pay', 'constructor']) {
    await rejected(await write(f, op, bodies[op], key), op, 20001, { fields: ['key'] });
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-06y#17] 三个写接口仅挂 admin，api 与 stream 无这些路由', async () => {
  const f = await setup(h);
  for (const op of OPERATIONS) expect(hasRoute(f.app, op)).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const app = await (await factory())(entry, f.overrides);
    h.apps.push(app);
    await app.init();
    for (const op of OPERATIONS) expect(hasRoute(app, op)).toBe(false);
  }
});

it('[AC-F1-06y#18] 三个写操作按已验证令牌 app_id 和 key 隔离，另一应用同名版本及审计保持不变', async () => {
  const f = await setup(h);
  const other = await seed(h, `f1-06y-other-${randomUUID()}`, { isSuper: true });
  await version(h, other, 'jd', 1, { ...REGISTERED, ever_published: true });
  await version(h, other, 'jd', 99, REGISTERED);
  await icon(h, other, 'jd', 1, 12);
  await version(h, f.actor, 'jd', 1);
  await version(h, f.actor, 'tmall', 1, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'tmall', 1, 7);
  const foreign = await snapshot(h, other.appId);
  const otherMark = await mark(h, f.appId, 'tmall');
  const otherVersion = await saved(h, f.appId, 'tmall');
  for (const op of ['source', 'publish'] as const) {
    const body =
      op === 'source'
        ? { expected_revision: 1, ...REGISTERED }
        : { expected_revision: 0, version: 99 };
    await rejected(await write(f, op, body, 'jd', 99), op, 20001, { fields: ['version'] });
  }
  await success(await write(f, 'source', { expected_revision: 1, ...REGISTERED }), 'source');
  expect(
    await success(await write(f, 'publish', { expected_revision: 0, version: 1 }), 'publish'),
  ).toMatchObject({ revision: 1, current_version: 1 });
  expect(
    await success(await write(f, 'restore', { expected_revision: 1 }), 'restore'),
  ).toMatchObject({ revision: 2, current_version: null });
  expect(await snapshot(h, other.appId)).toEqual(foreign);
  expect(await mark(h, f.appId, 'tmall')).toEqual(otherMark);
  expect(await saved(h, f.appId, 'tmall')).toEqual(otherVersion);
  const session = await signedIn(f, other);
  await success(
    await write({ ...f, token: session.admin_token }, 'restore', { expected_revision: 12 }),
    'restore',
  );
  expect(await mark(h, f.appId)).toMatchObject({ revision: 2, current_version: null });
  expect(await mark(h, other.appId)).toMatchObject({ revision: 13, current_version: null });
});

it.each(OPERATIONS)('[AC-F1-06y#19] %s 请求不能注入 app_id 或作者身份', async (op: Operation) => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, REGISTERED);
  const before = await snapshot(h, f.appId);
  await rejected(
    await write(f, op, { ...bodies[op], app_id: 'other', admin_id: randomUUID() }),
    op,
    20001,
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  createMediaStore,
  MEDIA_STORE,
  type MediaStore,
} from '../../../../../apps/api/src/modules/platform/media/index.ts';
import { grant, seed } from '../../../admin/accounts/kit.ts';
import { factory, signedIn, useHarness } from '../../../admin/auth/kit.ts';
import { guardOf } from '../../../admin/guard-mount/kit.ts';
import {
  OPERATIONS,
  SVG,
  create,
  hasRoute,
  pending,
  rejected,
  setup,
  snapshot,
  success,
  upload,
} from './kit.ts';

const h = useHarness();

it.each(OPERATIONS)(
  '[AC-F1-06x#7] %s 未登录 10001、无权限 10403；先过守卫再读流，授权后无需 step-up',
  async (op) => {
    const f = await setup(h);
    const row = await pending(h, f);
    const ordinary = await seed(h, f.appId);
    const session = await signedIn(f, ordinary);
    const call = (token: string | null) =>
      op === 'uploads'
        ? upload(f, SVG, 'jd', token)
        : create(f, { upload_id: row.id }, 'jd', token);
    await rejected(await call(null), op, 10001);
    const before = await snapshot(h, f.appId);
    const guard = await guardOf(f.app);
    const run = guard.run.bind(guard);
    const atRefusal: { parts: number; stream: number }[] = [];
    const spy = vi.spyOn(guard, 'run').mockImplementation(async (...args) => {
      try {
        return await run(...args);
      } catch (error) {
        // Capture before Fastify closes/drains the rejected HTTP request.
        atRefusal.push({ ...f.reads });
        throw error;
      }
    });
    try {
      for (const unrelated of [false, true]) {
        if (unrelated) await grant(h, ordinary, f.actor, ['user.list']);
        f.reads.parts = 0;
        f.reads.stream = 0;
        spy.mockClear();
        await rejected(await call(session.admin_token), op, 10403, {
          reason: 'admin_permission_denied',
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![0]).toMatchObject({ permission: 'content.platform_icon' });
        expect(atRefusal.at(-1)).toEqual({ parts: 0, stream: 0 });
      }
      expect(await snapshot(h, f.appId)).toEqual(before);
      await grant(h, ordinary, f.actor, ['content.platform_icon']);
      await success(await call(session.admin_token), op);
      if (op === 'uploads') {
        expect(f.reads.parts).toBeGreaterThan(0);
        const after = await snapshot(h, f.appId);
        expect(after.uploads.find((u) => u.id !== row.id)).toMatchObject({
          app_id: f.appId,
          created_by_admin_id: ordinary.id,
        });
      } else {
        expect((await snapshot(h, f.appId)).versions[0]).toMatchObject({
          created_by: ordinary.username,
          created_by_admin_id: ordinary.id,
        });
      }
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(OPERATIONS)('[AC-F1-06x#8] %s 未知 key 拒收 20001 [key]，无副作用', async (op) => {
  const f = await setup(h);
  const row = await pending(h, f);
  const before = await snapshot(h, f.appId);
  for (const key of ['unknown', 'JD', 'wechat-pay']) {
    const response =
      op === 'uploads' ? await upload(f, SVG, key) : await create(f, { upload_id: row.id }, key);
    await rejected(response, op, 20001, { fields: ['key'] });
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-06x#9] 真实路由仅挂 admin，api / stream 无接口且不接受 multipart', async () => {
  const f = await setup(h);
  expect(OPERATIONS.every((op) => hasRoute(f.app, op))).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const app = await (await factory())(entry, f.overrides);
    h.apps.push(app);
    await app.init();
    for (const op of OPERATIONS) expect(hasRoute(app, op)).toBe(false);
    expect([404, 415]).toContain((await upload({ ...f, app })).statusCode);
  }
});

it('[AC-F1-06x#10] 媒体公开地址缺失时上传返回 50001 且不泄露 upload_id', async () => {
  const f = await setup(h);
  // Model the validated staging/prod absent setting without starting external adapters.
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    config: { ...f.overrides.config, mediaPublicBaseUrl: undefined },
  });
  h.apps.push(app);
  await app.init();
  const unavailable = createMediaStore('staging', undefined, f.overrides.logger);
  const put = vi
    .spyOn(app.get<MediaStore>(MEDIA_STORE), 'put')
    .mockImplementation(unavailable.put.bind(unavailable));
  try {
    const response = await upload({ ...f, app });
    await rejected(response, 'uploads', 50001);
    expect(JSON.stringify(response.json())).not.toContain('upload_id');
    expect((await snapshot(h, f.appId)).versions).toEqual([]);
  } finally {
    put.mockRestore();
  }
});

it('[AC-F1-06x#11] 跨 app 上传与保存只采用已验证身份，不接受 body 注入作者或 app_id', async () => {
  const f = await setup(h);
  const other = await seed(h, `f1-06x-other-${randomUUID()}`, { isSuper: true });
  const session = await signedIn(f, other);
  const otherCaller = { ...f, token: session.admin_token };
  const theirs = await success(await upload(otherCaller), 'uploads');
  const before = await snapshot(h, other.appId);
  await rejected(await create(f, { upload_id: theirs.upload_id }), 'versions', 20001, {
    fields: ['upload_id'],
  });
  await rejected(
    await create(f, {
      upload_id: theirs.upload_id,
      app_id: other.appId,
      created_by_admin_id: other.id,
    }),
    'versions',
    20001,
  );
  expect(await snapshot(h, other.appId)).toEqual(before);
  const mine = await success(await upload(f), 'uploads');
  expect(mine.sha256).toBe(theirs.sha256);
  expect(mine.upload_id).not.toBe(theirs.upload_id);
  expect((await snapshot(h, f.appId)).uploads[0]).toMatchObject({
    app_id: f.appId,
    created_by_admin_id: f.actor.id,
  });
  expect(before.uploads[0]).toMatchObject({ app_id: other.appId, created_by_admin_id: other.id });
  await success(
    await create(otherCaller, { upload_id: theirs.upload_id, sanitized_confirmed: true }),
    'versions',
  );
  const savedForeign = await snapshot(h, other.appId);
  // A foreign already-saved upload must not leak through the idempotency shortcut either.
  await rejected(await create(f, { upload_id: theirs.upload_id }), 'versions', 20001, {
    fields: ['upload_id'],
  });
  expect(await snapshot(h, other.appId)).toEqual(savedForeign);
  expect((await snapshot(h, f.appId)).versions).toEqual([]);
});

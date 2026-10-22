import { expect, it, vi } from 'vitest';
import { grant, seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import { guardOf } from '../../admin/guard-mount/kit.ts';
import { lottie } from './fixtures.ts';
import { rejected, setup, snapshot, success, upload } from './kit.ts';

const h = useHarness();

it.each([null, '', 'video', 'LOTTIE'])(
  '[AC-F1-09r#18] kind=%j 缺失或非法 → 20001 [kind] 无 reason 与副作用',
  async (kind) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = vi.spyOn(f.media, 'put');
    try {
      await rejected(await upload(f, lottie(), { kind }), 20001, { fields: ['kind'] });
      expect(put).not.toHaveBeenCalled();
      expect(await snapshot(h, f.appId)).toEqual(before);
    } finally {
      put.mockRestore();
    }
  },
);

it('[AC-F1-09r#19] 未登录 10001、无 content.page 10403；拒绝前不读流，授权无需 step-up', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  const session = await signedIn(f, ordinary);
  await rejected(await upload(f, lottie(), { token: null }), 10001);
  const before = await snapshot(h, f.appId);
  const guard = await guardOf(f.app);
  const run = guard.run.bind(guard);
  const atRefusal: { parts: number; stream: number }[] = [];
  const spy = vi.spyOn(guard, 'run').mockImplementation(async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      atRefusal.push({ ...f.reads });
      throw error;
    }
  });
  const put = vi.spyOn(f.media, 'put');
  try {
    f.reads.parts = 0;
    f.reads.stream = 0;
    await rejected(await upload(f, lottie(), { token: session.admin_token }), 10403, {
      reason: 'admin_permission_denied',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ permission: 'content.page' });
    expect(atRefusal).toEqual([{ parts: 0, stream: 0 }]);
    expect(put).not.toHaveBeenCalled();
    expect(await snapshot(h, f.appId)).toEqual(before);
    await grant(h, ordinary, f.owner, ['content.page']);
    const result = await success(await upload(f, lottie(), { token: session.admin_token }));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.reads.parts).toBeGreaterThan(0);
    const audits = (await snapshot(h, f.appId)).audits.filter(
      (row) => row.action === 'page_popup_asset_upload',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ admin_id: ordinary.id, app_id: f.appId });
  } finally {
    spy.mockRestore();
    put.mockRestore();
  }
});

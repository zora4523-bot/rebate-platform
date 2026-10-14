import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createTaobaoLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open-taobao.ts';
import { setup } from '../../linking/open-taobao/kit.ts';
import { accountSlots, databaseFixture, outcome } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const scene of ['detail', 'share'] as const) {
  it(`[AC-B1-19d#5] 淘宝 ${scene}: relation 属 A，B 先激活仍用 A；A 缺位和错账号答复仍 50301`, async () => {
    const db = database();
    const f = await setup(db, scene);
    await f.bind('active');
    const slots = await accountSlots(db, f.appId, 'taobao', f.account);
    const selected = scene === 'share' ? 'share' : 'self_buy';
    const service = createTaobaoLinkOpen({ ...f.options, pids: slots.pids });
    // BR-ATTR-11: the sharer opening his own share link is re-registered as self_buy; the share
    // slot is exercised by another user opening A's share link (A's identity and relation).
    if (scene === 'share') f.opener(f.b);
    const success = await outcome(() => service.open(f.request()));
    const read = slots.pids.getActivePid.getMockImplementation()!;
    // 保留 B1-06f 的最后防线：即便端口违反账号条件，不能拼 B 的 pid 和 A 的 relation。
    slots.pids.getActivePid.mockResolvedValue(slots.b[selected]);
    const wrongAccount = await outcome(() => service.open(f.request()));
    slots.pids.getActivePid.mockImplementation(read);
    // 只改变合成数据状态，真实查询证明缺位不会回退 B。
    await db
      .updateTable('union_pids')
      .set({ status: 'retired' })
      .where('app_id', '=', f.appId)
      .where('id', '=', slots.a[selected].id)
      .execute();
    const missing = await outcome(() => service.open(f.request()));
    expect(success).toMatchObject({
      status: 200,
      envelope: {
        code: 0,
        data: {
          jump: {
            primary: {
              type: 'sdk',
              sdk: {
                provider: 'baichuan',
                open_by: 'code',
                page: 'detail',
                taoke: { pid: slots.a[selected].pid, relation_id: 'rel-A' },
              },
            },
          },
        },
      },
    });
    for (const result of [wrongAccount, missing]) {
      expect(result).toMatchObject({ envelope: { code: 50301 } });
      expect(result).not.toHaveProperty('envelope.data.jump');
    }
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.resolveLink).not.toHaveBeenCalled();
    expect(JSON.stringify([success, wrongAccount, missing])).not.toContain(f.canary);
  }, 30_000);
}

for (const binding of ['active', 'invalid', 'blocked'] as const) {
  it(`[AC-B1-19d#6] 淘宝 no_rebate/${binding}: 所用账号 A 的 self_buy 位，不带 relation`, async () => {
    const db = database();
    const f = await setup(db, 'share');
    await f.bind(binding);
    const slots = await accountSlots(db, f.appId, 'taobao', f.account);
    const service = createTaobaoLinkOpen({ ...f.options, pids: slots.pids });
    const result = await outcome(() => service.open(f.request({ noRebate: true })));
    expect(result).toMatchObject({
      envelope: {
        code: 0,
        data: {
          jump: {
            primary: {
              type: 'sdk',
              sdk: { open_by: 'code', taoke: { pid: slots.a.self_buy.pid } },
            },
          },
        },
      },
    });
    expect(result).not.toHaveProperty('envelope.data.jump.primary.sdk.taoke.relation_id');
    expect(slots.pids.getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: f.appId,
        platform: 'taobao',
        pidScene: 'self_buy',
        unionAccountId: f.account,
      }),
    );
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.resolveLink).not.toHaveBeenCalled();
    if (binding === 'active') {
      // 无未释放绑定时，和 auth-url 一样改用最早 self_buy 位所属账号 B。
      await db
        .updateTable('union_bindings')
        .set({ status: 'released', released_at: f.f.clock.now(), cooldown_until: f.f.clock.now() })
        .where('app_id', '=', f.appId)
        .where('user_id', '=', f.a)
        .execute();
      const unbound = await outcome(() => service.open(f.request({ noRebate: true })));
      expect(unbound).toMatchObject({
        envelope: {
          code: 0,
          data: {
            jump: {
              primary: {
                sdk: { taoke: { pid: slots.b.self_buy.pid } },
              },
            },
          },
        },
      });
      expect(unbound).not.toHaveProperty('envelope.data.jump.primary.sdk.taoke.relation_id');
    }
  }, 30_000);
}

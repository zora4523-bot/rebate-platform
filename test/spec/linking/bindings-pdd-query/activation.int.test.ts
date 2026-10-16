import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { newAccount } from '../relation-conflict/records.ts';
import { fixture, listed, noSideEffects, TIMEOUT } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-06x#1] %s 查询已授权：self_buy 身份、原地 CAS 或插入且保留 released 历史',
  async (status) => {
    const f = await fixture(database(), status);
    const before = await f.bindings();
    f.clock.advanceMs(12_345);
    await listed(await f.list(), 'active');
    expect(f.query).toHaveBeenCalledTimes(1);
    const [identity, ctx] = f.query.mock.calls[0]!;
    expect((identity as JdPddIdentity).custom_parameters).toEqual({
      app: 'n',
      uid: f.a.attr,
      sc: 'self_buy',
    });
    expect(identity.claims).toMatchObject({
      appId: f.appId,
      platform: 'pdd',
      promotionSlot: 'synthetic-self-buy',
      userId: f.a.attr,
    });
    expect(JSON.stringify(f.query.mock.calls[0])).not.toContain(f.a.userId);
    expect(JSON.stringify(f.query.mock.calls[0])).not.toMatch(/user_id|device_id/);
    expect(ctx).toMatchObject({ appId: f.appId, requestId: f.traceId, purpose: 'online' });
    // B1-06zb: the refresh may also pass the account in use (unionAccountId); these four stay fixed.
    expect(f.getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: f.appId,
        platform: 'pdd',
        pidScene: 'self_buy',
        purpose: 'convert',
      }),
    );
    expect(f.attrCode).toHaveBeenCalledWith(f.appId, f.a.userId);
    expect(f.get.mock.calls.every(([platform]) => platform === 'pdd')).toBe(true);
    const rows = await f.bindings();
    const active = rows.filter((row) => row.status === 'active');
    expect(active).toHaveLength(1);
    expect(rows).toHaveLength(status === 'released' ? 2 : 1);
    expect(active[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.a.userId,
      platform: 'pdd',
      union_account_id: f.accountId,
      bound_at: f.clock.now(),
      updated_at: f.clock.now(),
    });
    expect(JSON.parse(active[0]!.pdd_custom!)).toEqual({
      app: 'n',
      uid: f.a.attr,
      sc: 'self_buy',
    });
    if (status === 'released') {
      expect(rows.find((row) => row.id === f.bindingId)).toEqual(before[0]);
      expect(active[0]!.id).not.toBe(f.bindingId);
    } else if (status !== 'absent') {
      expect(active[0]).toMatchObject({ id: f.bindingId, row_version: before[0]!.row_version + 1 });
    }
    await noSideEffects(f);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06x#12] 身份取自 callerContext，只刷新当前用户 pdd，淘宝 invalid 不查联盟',
  async () => {
    const f = await fixture(database());
    const original = (await f.bindings())[0]!;
    const currentBinding = await f.bind('invalid', f.b.userId);
    f.clock.advanceMs(1_000);
    const taobaoAccount = await newAccount(f.db, f.appId, 'taobao', f.clock.now());
    const taobao = await f.db
      .insertInto('union_bindings')
      .values({
        ...original,
        id: f.b.deviceId,
        user_id: f.b.userId,
        platform: 'taobao',
        union_account_id: taobaoAccount,
        relation_id: 'synthetic-taobao-relation',
        pdd_custom: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    f.current.mockResolvedValue({ appId: f.appId, userId: f.b.userId, deviceId: f.b.deviceId });
    f.attrCode.mockResolvedValue(f.b.attr);
    await listed(await f.list(), 'active', 'invalid');
    expect(f.attrCode).toHaveBeenCalledWith(f.appId, f.b.userId);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]![0]).toMatchObject({
      custom_parameters: { app: 'n', uid: f.b.attr, sc: 'self_buy' },
    });
    expect(f.get.mock.calls.every(([platform]) => platform === 'pdd')).toBe(true);
    const rows = await f.bindings();
    expect(rows.find((row) => row.id === original.id)).toEqual(original);
    expect(rows.find((row) => row.id === taobao.id)).toEqual(taobao);
    expect(rows.find((row) => row.id === currentBinding)).toMatchObject({
      user_id: f.b.userId,
      status: 'active',
      row_version: 8,
    });
    await noSideEffects(f);
  },
  TIMEOUT,
);

it.each(['pending_auth', 'invalid'] as const)(
  '[AC-B1-06x#2] %s 保留原账号和已有 bound_at，不被当前推广位账号覆盖',
  async (status) => {
    const f = await fixture(database(), status);
    const oldBoundAt = f.clock.now();
    f.clock.advanceMs(60_000);
    const selected = await newAccount(f.db, f.appId, 'pdd', f.clock.now());
    await f.db
      .updateTable('union_bindings')
      .set({ bound_at: oldBoundAt })
      .where('id', '=', f.bindingId!)
      .execute();
    const slot = await f.getActivePid({
      appId: f.appId,
      platform: 'pdd',
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    f.getActivePid.mockResolvedValue({ ...slot!, union_account_id: selected });
    await listed(await f.list(), 'active');
    expect(await f.bindings()).toEqual([
      expect.objectContaining({
        id: f.bindingId,
        union_account_id: f.accountId,
        bound_at: oldBoundAt,
        status: 'active',
        row_version: 8,
      }),
    ]);
    await noSideEffects(f);
  },
  TIMEOUT,
);

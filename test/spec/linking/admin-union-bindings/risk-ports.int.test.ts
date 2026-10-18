import { expect, it } from 'vitest';
import { blockForBan, restoreAfterUnban } from '../../../../apps/api/src/modules/linking/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { STATES, setup, binding, current, snapshot } from './kit.ts';

const h = useHarness();

for (const platform of ['taobao', 'pdd']) {
  for (const [status, reason] of STATES) {
    it(`[AC-F1-07c#13] 封禁联动 ${platform}/${status}/${reason}，停用原因不可被覆盖`, async () => {
      const s = await setup(h);
      const row =
        status === 'absent'
          ? undefined
          : await binding(s, { platform, status, blocked_reason: reason });
      const before = await s.rows();
      await h.db.transaction().execute((trx) =>
        blockForBan(trx, {
          appId: s.appId,
          userId: s.userId,
          clock: s.f.clock,
        }),
      );
      if (row !== undefined && ['active', 'invalid', 'pending_auth'].includes(status)) {
        expect(await current(s, row.id)).toMatchObject({
          status: 'blocked',
          blocked_reason: 'ban',
          row_version: row.row_version + 1,
          released_at: null,
          cooldown_until: null,
          bound_at: row.bound_at,
        });
      } else expect(await s.rows()).toEqual(before);
      const once = await s.rows();
      await h.db.transaction().execute((trx) =>
        blockForBan(trx, {
          appId: s.appId,
          userId: s.userId,
          clock: s.f.clock,
        }),
      );
      expect(await s.rows()).toEqual(once);
    });

    it(`[AC-F1-07c#14] 解封联动 ${platform}/${status}/${reason}，只恢复 blocked(ban)`, async () => {
      const s = await setup(h);
      const row =
        status === 'absent'
          ? undefined
          : await binding(s, { platform, status, blocked_reason: reason });
      const before = await s.rows();
      await h.db.transaction().execute((trx) =>
        restoreAfterUnban(trx, {
          appId: s.appId,
          userId: s.userId,
          clock: s.f.clock,
        }),
      );
      if (row !== undefined && status === 'blocked' && reason === 'ban') {
        const after = await current(s, row.id);
        expect(after).toMatchObject({
          status: platform === 'taobao' ? 'invalid' : 'active',
          blocked_reason: null,
          released_at: null,
          cooldown_until: null,
          bound_at: row.bound_at,
        });
        if (platform === 'taobao') expect(after.row_version).toBe(row.row_version + 1);
        else expect(after.row_version).toBeGreaterThan(row.row_version);
      } else expect(await s.rows()).toEqual(before);
      const once = await s.rows();
      await h.db.transaction().execute((trx) =>
        restoreAfterUnban(trx, {
          appId: s.appId,
          userId: s.userId,
          clock: s.f.clock,
        }),
      );
      expect(await s.rows()).toEqual(once);
    });
  }
}

it.each(['ban', 'unban'] as const)(
  '[AC-F1-07c#15] %s 使用调用方事务，回滚后所有平台绑定复原',
  async (operation) => {
    const s = await setup(h);
    const patch = operation === 'unban' ? { status: 'blocked', blocked_reason: 'ban' } : {};
    const rows = [
      await binding(s, { ...patch, platform: 'taobao' }),
      await binding(s, { ...patch, platform: 'pdd' }),
    ];
    const before = await snapshot(s);
    const rollback = new Error('synthetic-caller-rollback');
    await expect(
      h.db.transaction().execute(async (trx) => {
        const port = operation === 'ban' ? blockForBan : restoreAfterUnban;
        await port(trx, { appId: s.appId, userId: s.userId, clock: s.f.clock });
        const inside = await trx
          .selectFrom('union_bindings')
          .selectAll()
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        expect(inside).toHaveLength(2);
        for (const row of inside)
          expect(row.status).toBe(
            operation === 'ban' ? 'blocked' : row.platform === 'taobao' ? 'invalid' : 'active',
          );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot(s)).toEqual(before);
  },
);

it.each([blockForBan, restoreAfterUnban])(
  '[AC-F1-07c#16] 联动端口 %s 按 app_id 和用户隔离',
  async (port) => {
    const s = await setup(h);
    const other = await setup(h);
    await binding(
      other,
      port === restoreAfterUnban ? { status: 'blocked', blocked_reason: 'ban' } : {},
    );
    const before = await snapshot(other);
    await h.db.transaction().execute((trx) =>
      port(trx, {
        appId: s.appId,
        userId: other.userId,
        clock: s.f.clock,
      }),
    );
    expect(await snapshot(other)).toEqual(before);
    expect(await s.rows()).toEqual([]);
  },
);

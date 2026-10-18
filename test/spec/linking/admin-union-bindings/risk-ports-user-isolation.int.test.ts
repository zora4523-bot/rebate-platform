import { expect, it } from 'vitest';
import { blockForBan, restoreAfterUnban } from '../../../../apps/api/src/modules/linking/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { binding, current, setup } from './kit.ts';

const h = useHarness();

for (const operation of ['ban', 'unban'] as const) {
  it.each(['active', 'invalid', 'blocked'] as const)(
    `[AC-F1-07c#26] ${operation} 不改变同 app 另一用户各平台的 %s 绑定`,
    async (status) => {
      const target = await setup(h);
      const other = await setup(h, { appId: target.appId });
      expect(other.appId).toBe(target.appId);
      expect(other.userId).not.toBe(target.userId);

      // 每个场景每平台仅一条当前绑定，遵守 user/platform 唯一约束。
      const targetRows = [];
      for (const platform of ['taobao', 'pdd']) {
        targetRows.push(
          await binding(target, {
            platform,
            status: operation === 'ban' ? 'active' : 'blocked',
            blocked_reason: operation === 'ban' ? null : 'ban',
          }),
        );
        await binding(other, {
          platform,
          status,
          blocked_reason: status === 'blocked' ? 'ban' : null,
        });
      }
      const before = await other.rows();
      expect(before).toHaveLength(2);
      // 让误写 updated_at 也可观察，避免相同固定时刻掩盖越界更新。
      target.f.clock.advanceMs(60_000);

      const port = operation === 'ban' ? blockForBan : restoreAfterUnban;
      await h.db.transaction().execute((trx) =>
        port(trx, {
          appId: target.appId,
          userId: target.userId,
          clock: target.f.clock,
        }),
      );

      // 整行比较包含 status、blocked_reason、row_version、updated_at。
      expect(await other.rows()).toEqual(before);
      for (const row of targetRows) {
        expect(await current(target, row.id)).toMatchObject({
          status: operation === 'ban' ? 'blocked' : 'invalid',
          blocked_reason: operation === 'ban' ? 'ban' : null,
          row_version: row.row_version + 1,
        });
      }
    },
  );
}

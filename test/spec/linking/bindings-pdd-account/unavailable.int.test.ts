import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { conflict } from '../relation-conflict/records.ts';
import {
  accountFixture,
  databaseFixture,
  listed,
  noSideEffects,
  snapshot,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const status of ['pending_auth', 'invalid'] as const) {
  it.each(['pending', 'retired'] as const)(
    `[AC-B1-06zb#4] ${status}/%s：仅 B 有 active self_buy 位，200 返回原投影、不查联盟不写库并记 warn`,
    async (availability) => {
      const f = await accountFixture(database(), status);
      await f.db
        .updateTable('union_pids')
        .set({ status: availability })
        .where('app_id', '=', f.appId)
        .where('id', '=', f.slots.a.self_buy.id)
        .execute();
      // A 的 share / agent 位仍 active，既不能跨账号，也不能跨场景补位。
      await conflict(
        f.db,
        { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
        f.clock.now(),
      );
      const before = await snapshot(f);
      const result = await f.list();
      expect(f.query).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      await listed(result, status);
      expect(await snapshot(f)).toEqual(before);
      expect(f.getActivePid).toHaveBeenCalledWith({
        appId: f.appId,
        platform: 'pdd',
        pidScene: 'self_buy',
        purpose: 'convert',
        unionAccountId: f.accountId,
      });
      expect(f.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'linking.bindings.no_active_pid',
          app_id: f.appId,
          platform: 'pdd',
          pid_scene: 'self_buy',
        }),
        expect.any(String),
      );
      await noSideEffects(f);
    },
    TIMEOUT,
  );
}

it(
  '[AC-B1-06zb#5] 推广位端口误回 B 的行时拒绝使用，维持 A 的库内投影并记 warn',
  async () => {
    const f = await accountFixture(database());
    f.getActivePid.mockResolvedValue(f.slots.b.self_buy);
    const before = await snapshot(f);
    const result = await f.list();
    expect(f.query).not.toHaveBeenCalled();
    await listed(result, 'invalid');
    expect(await snapshot(f)).toEqual(before);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'linking.bindings.no_active_pid', app_id: f.appId }),
      expect.any(String),
    );
    await noSideEffects(f);
  },
  TIMEOUT,
);
